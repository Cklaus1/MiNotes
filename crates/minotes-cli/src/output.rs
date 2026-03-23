use serde::Serialize;

#[derive(Clone, clap::ValueEnum)]
pub enum OutputFormat {
    Json,
    Table,
}

pub fn print_json<T: Serialize>(data: &T) {
    println!("{}", serde_json::to_string_pretty(data).unwrap_or_default());
}

pub fn print_message(msg: &str) {
    println!("{}", serde_json::json!({"message": msg}));
}

pub fn print_error(err: &str) {
    eprintln!("{}", serde_json::json!({"error": err}));
}
