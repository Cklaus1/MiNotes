use clap::Subcommand;
use minotes_core::db::Database;
use uuid::Uuid;

use crate::output::{print_error, print_json, print_message};

#[derive(Subcommand)]
pub enum PropertyCmd {
    /// Set a property on a block or page
    Set {
        /// Block or page UUID
        entity_id: String,
        /// Property key
        key: String,
        /// Property value
        value: String,
        /// Value type (text, number, date, url, email, select, checkbox)
        #[arg(long, default_value = "text")]
        r#type: String,
        /// Entity type (block or page)
        #[arg(long, default_value = "block")]
        entity_type: String,
    },
    /// Get all properties for an entity
    Get {
        /// Block or page UUID
        entity_id: String,
    },
    /// Delete a property
    Delete {
        /// Block or page UUID
        entity_id: String,
        /// Property key
        key: String,
    },
}

pub fn run(db: &Database, cmd: PropertyCmd, actor: &str) -> i32 {
    match cmd {
        PropertyCmd::Set { entity_id, key, value, r#type, entity_type } => {
            let Ok(uuid) = Uuid::parse_str(&entity_id) else {
                print_error("Invalid UUID");
                return 1;
            };
            match db.set_property(&uuid, &entity_type, &key, &value, &r#type, actor) {
                Ok(prop) => { print_json(&prop); 0 }
                Err(e) => { print_error(&e.to_string()); 1 }
            }
        }
        PropertyCmd::Get { entity_id } => {
            let Ok(uuid) = Uuid::parse_str(&entity_id) else {
                print_error("Invalid UUID");
                return 1;
            };
            match db.get_properties(&uuid) {
                Ok(props) => { print_json(&props); 0 }
                Err(e) => { print_error(&e.to_string()); 1 }
            }
        }
        PropertyCmd::Delete { entity_id, key } => {
            let Ok(uuid) = Uuid::parse_str(&entity_id) else {
                print_error("Invalid UUID");
                return 1;
            };
            match db.delete_property(&uuid, &key, actor) {
                Ok(true) => { print_message(&format!("Deleted property: {key}")); 0 }
                Ok(false) => { print_error(&format!("Property not found: {key}")); 2 }
                Err(e) => { print_error(&e.to_string()); 1 }
            }
        }
    }
}
