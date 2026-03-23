use chrono::{Duration, Utc};
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::{Card, SrsStats};

/// Default FSRS-4 weights.
const W: [f64; 17] = [
    0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26,
    0.29, 2.61,
];

fn rating_value(rating: &str) -> Result<usize> {
    match rating {
        "again" => Ok(0),
        "hard" => Ok(1),
        "good" => Ok(2),
        "easy" => Ok(3),
        _ => Err(Error::InvalidInput(format!("Invalid rating: {rating}"))),
    }
}

fn clamp(val: f64, min: f64, max: f64) -> f64 {
    if val < min {
        min
    } else if val > max {
        max
    } else {
        val
    }
}

/// Compute new stability after a successful recall (hard/good/easy).
fn next_recall_stability(stability: f64, difficulty: f64, retrievability: f64) -> f64 {
    stability
        * (1.0
            + f64::exp(W[8]) * (11.0 - difficulty) * stability.powf(-W[9])
                * (f64::exp(W[10] * (1.0 - retrievability)) - 1.0))
}

/// Compute new stability after a lapse (again).
fn next_forget_stability(stability: f64, difficulty: f64) -> f64 {
    W[11] * difficulty.powf(-W[12]) * ((stability + 1.0).powf(W[13]) - 1.0)
}

/// Compute retrievability given elapsed days and stability.
fn retrievability(elapsed_days: f64, stability: f64) -> f64 {
    if stability <= 0.0 {
        return 0.0;
    }
    f64::powf(1.0 + elapsed_days / (9.0 * stability), -1.0)
}

impl Database {
    pub fn create_card(&self, block_id: &Uuid, card_type: &str, actor: &str) -> Result<Card> {
        let now = Utc::now();
        let id = Uuid::now_v7();

        // Verify block exists
        let exists: bool = self.conn.query_row(
            "SELECT COUNT(*) > 0 FROM blocks WHERE id = ?1",
            [block_id.to_string()],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(Error::NotFound(format!("Block {block_id}")));
        }

        let card = Card {
            id,
            block_id: *block_id,
            card_type: card_type.to_string(),
            due: now,
            stability: 0.0,
            difficulty: 0.0,
            reps: 0,
            lapses: 0,
            state: "new".to_string(),
            last_review: None,
            created_at: now,
            updated_at: now,
        };

        self.conn.execute(
            "INSERT INTO cards (id, block_id, card_type, due, stability, difficulty, reps, lapses, state, last_review, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            rusqlite::params![
                card.id.to_string(),
                card.block_id.to_string(),
                card.card_type,
                card.due.to_rfc3339(),
                card.stability,
                card.difficulty,
                card.reps,
                card.lapses,
                card.state,
                card.last_review.map(|d| d.to_rfc3339()),
                card.created_at.to_rfc3339(),
                card.updated_at.to_rfc3339(),
            ],
        )?;

        self.emit_event("card.created", &card.id, "card", &card, actor)?;
        Ok(card)
    }

    pub fn get_due_cards(&self, limit: i64) -> Result<Vec<Card>> {
        let now = Utc::now().to_rfc3339();
        let mut stmt = self.conn.prepare(
            "SELECT id, block_id, card_type, due, stability, difficulty, reps, lapses, state, last_review, created_at, updated_at
             FROM cards WHERE due <= ?1 ORDER BY due ASC LIMIT ?2",
        )?;

        let cards = stmt
            .query_map(rusqlite::params![now, limit], |row| {
                Ok(Self::row_to_card(row))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(cards)
    }

    pub fn review_card(&self, card_id: &Uuid, rating: &str, _actor: &str) -> Result<Card> {
        let now = Utc::now();
        let rv = rating_value(rating)?;

        // Load current card
        let mut card: Card = self
            .conn
            .query_row(
                "SELECT id, block_id, card_type, due, stability, difficulty, reps, lapses, state, last_review, created_at, updated_at
                 FROM cards WHERE id = ?1",
                [card_id.to_string()],
                |row| Ok(Self::row_to_card(row)),
            )
            .map_err(|_| Error::NotFound(format!("Card {card_id}")))?;

        if card.state == "new" {
            // First review: initial stability from weights, initial difficulty
            card.stability = W[rv].max(0.1);
            card.difficulty = clamp(W[4] - W[5] * (rv as f64 - 3.0), 1.0, 10.0);
            card.reps = 1;
            card.state = if rv == 0 {
                "learning".to_string()
            } else {
                "review".to_string()
            };
            if rv == 0 {
                card.lapses += 1;
            }
        } else {
            // Compute elapsed days
            let elapsed_days = if let Some(last) = card.last_review {
                (now - last).num_seconds() as f64 / 86400.0
            } else {
                0.0
            };

            let r = retrievability(elapsed_days, card.stability);

            // Update difficulty
            card.difficulty = clamp(card.difficulty + W[6] * (rv as f64 - 3.0), 1.0, 10.0);

            if rv == 0 {
                // Again — lapse
                card.stability = next_forget_stability(card.stability, card.difficulty).max(0.1);
                card.lapses += 1;
                card.state = "relearning".to_string();
            } else {
                // Hard / Good / Easy
                card.stability = next_recall_stability(card.stability, card.difficulty, r).max(0.1);
                card.state = "review".to_string();
            }
            card.reps += 1;
        }

        // Schedule next due date: now + stability days (min 1 minute for again)
        let interval_secs = if rv == 0 {
            60.0 // 1 minute for again
        } else {
            card.stability * 86400.0
        };
        card.due = now + Duration::seconds(interval_secs as i64);
        card.last_review = Some(now);
        card.updated_at = now;

        self.conn.execute(
            "UPDATE cards SET due = ?1, stability = ?2, difficulty = ?3, reps = ?4, lapses = ?5, state = ?6, last_review = ?7, updated_at = ?8 WHERE id = ?9",
            rusqlite::params![
                card.due.to_rfc3339(),
                card.stability,
                card.difficulty,
                card.reps,
                card.lapses,
                card.state,
                card.last_review.map(|d| d.to_rfc3339()),
                card.updated_at.to_rfc3339(),
                card.id.to_string(),
            ],
        )?;

        Ok(card)
    }

    pub fn get_srs_stats(&self) -> Result<SrsStats> {
        let now = Utc::now().to_rfc3339();
        let today_start = Utc::now()
            .date_naive()
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
            .to_rfc3339();

        let due_count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM cards WHERE due <= ?1",
            [&now],
            |row| row.get(0),
        )?;

        let reviewed_today: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM cards WHERE last_review >= ?1",
            [&today_start],
            |row| row.get(0),
        )?;

        let total_cards: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM cards", [], |row| row.get(0))?;

        Ok(SrsStats {
            due_count,
            reviewed_today,
            total_cards,
        })
    }

    pub fn delete_card(&self, card_id: &Uuid, _actor: &str) -> Result<bool> {
        let rows = self.conn.execute(
            "DELETE FROM cards WHERE id = ?1",
            [card_id.to_string()],
        )?;
        Ok(rows > 0)
    }

    fn row_to_card(row: &rusqlite::Row) -> Card {
        let id_str: String = row.get_unwrap(0);
        let block_id_str: String = row.get_unwrap(1);
        let due_str: String = row.get_unwrap(3);
        let last_review_str: Option<String> = row.get_unwrap(9);
        let created_str: String = row.get_unwrap(10);
        let updated_str: String = row.get_unwrap(11);

        Card {
            id: Uuid::parse_str(&id_str).unwrap(),
            block_id: Uuid::parse_str(&block_id_str).unwrap(),
            card_type: row.get_unwrap(2),
            due: chrono::DateTime::parse_from_rfc3339(&due_str)
                .unwrap()
                .with_timezone(&Utc),
            stability: row.get_unwrap(4),
            difficulty: row.get_unwrap(5),
            reps: row.get_unwrap(6),
            lapses: row.get_unwrap(7),
            state: row.get_unwrap(8),
            last_review: last_review_str.map(|s| {
                chrono::DateTime::parse_from_rfc3339(&s)
                    .unwrap()
                    .with_timezone(&Utc)
            }),
            created_at: chrono::DateTime::parse_from_rfc3339(&created_str)
                .unwrap()
                .with_timezone(&Utc),
            updated_at: chrono::DateTime::parse_from_rfc3339(&updated_str)
                .unwrap()
                .with_timezone(&Utc),
        }
    }
}
