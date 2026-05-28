use crate::db::Database;
use crate::error::{Error, Result};

impl Database {
    /// Count pending TODOs across all pages by scanning block content.
    /// Recognizes: - [ ], - [x], TODO:, Action:, Follow up:, Next:
    pub fn count_pending_todos(&self) -> Result<usize> {
        let mut stmt = self.conn.prepare(
            "SELECT b.content FROM block b
             JOIN page p ON b.page_id = p.id
             WHERE p.deleted_at IS NULL AND p.trashed_at IS NULL",
        )?;

        let mut rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut count = 0;

        while let Some(Ok(content)) = rows.next() {
            for line in content.split('\n') {
                let trimmed = line.trim();

                // Checkbox: - [ ] or - [ ]
                if trimmed.starts_with("- [ ]")
                    || trimmed.starts_with("* [ ]")
                    || trimmed.starts_with("+ [ ]")
                {
                    count += 1;
                    continue;
                }

                // Action keywords
                if trimmed
                    .chars()
                    .take_while(|c| !c.is_whitespace())
                    .collect::<String>()
                    .to_lowercase()
                    .starts_with("todo:")
                    || trimmed
                        .chars()
                        .take_while(|c| !c.is_whitespace())
                        .collect::<String>()
                        .to_lowercase()
                        .starts_with("action:")
                    || trimmed
                        .chars()
                        .take_while(|c| !c.is_whitespace())
                        .collect::<String>()
                        .to_lowercase()
                        .starts_with("follow up:")
                    || trimmed
                        .chars()
                        .take_while(|c| !c.is_whitespace())
                        .collect::<String>()
                        .to_lowercase()
                        .starts_with("follow-up:")
                    || trimmed
                        .chars()
                        .take_while(|c| !c.is_whitespace())
                        .collect::<String>()
                        .to_lowercase()
                        .starts_with("next:")
                {
                    count += 1;
                }
            }
        }

        Ok(count)
    }
}