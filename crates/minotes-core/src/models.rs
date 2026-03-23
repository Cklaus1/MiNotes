use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Folder {
    pub id: Uuid,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub position: f64,
    pub collapsed: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Folder with its children (for tree rendering).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderTree {
    #[serde(flatten)]
    pub folder: Folder,
    pub children: Vec<FolderTree>,
    pub pages: Vec<Page>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Page {
    pub id: Uuid,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<Uuid>,
    pub is_journal: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub journal_date: Option<NaiveDate>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Block {
    pub id: Uuid,
    pub page_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<Uuid>,
    pub position: f64,
    pub content: String,
    pub format: String,
    pub collapsed: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Link {
    pub id: Uuid,
    pub from_block: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_page: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_block: Option<Uuid>,
    pub link_type: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Property {
    pub id: Uuid,
    pub entity_id: Uuid,
    pub entity_type: String,
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    pub value_type: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub id: i64,
    pub event_type: String,
    pub entity_id: Uuid,
    pub entity_type: String,
    pub payload: serde_json::Value,
    pub actor: String,
    pub created_at: DateTime<Utc>,
}

/// A page with its block tree (for --tree output).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageTree {
    #[serde(flatten)]
    pub page: Page,
    pub blocks: Vec<Block>,
}
