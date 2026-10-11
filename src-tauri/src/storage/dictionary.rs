use anyhow::Result;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DictionaryEntry {
    pub id: i64,
    pub word: String,
    pub pronunciation: Option<String>,
}

pub struct DictionaryStore {
    conn: Mutex<Connection>,
}

impl DictionaryStore {
    pub fn new(db_path: PathBuf) -> Result<Self> {
        let conn = Connection::open(&db_path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS dictionary (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                word TEXT NOT NULL,
                pronunciation TEXT
            );",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub async fn list(&self) -> Result<Vec<DictionaryEntry>> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = conn.prepare("SELECT id, word, pronunciation FROM dictionary")?;
        let rows = stmt.query_map([], |row| {
            Ok(DictionaryEntry {
                id: row.get(0)?,
                word: row.get(1)?,
                pronunciation: row.get(2)?,
            })
        })?;
        let mut entries = Vec::new();
        for row in rows {
            entries.push(row?);
        }
        Ok(entries)
    }

    pub async fn words(&self) -> Vec<String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare("SELECT word FROM dictionary") {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = match stmt.query_map([], |row| row.get::<_, String>(0)) {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };
        rows.filter_map(|r| r.ok()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn test_database(name: &str) -> (PathBuf, PathBuf) {
        let sequence = TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
        let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!(
                "echolike-dictionary-{name}-{}-{sequence}",
                std::process::id()
            ));
        fs::create_dir_all(&directory).unwrap();
        (directory.join("dictionary.db"), directory)
    }

    fn in_memory_dictionary_store() -> DictionaryStore {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE dictionary (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                word TEXT NOT NULL,
                pronunciation TEXT
            );",
        )
        .unwrap();
        DictionaryStore {
            conn: Mutex::new(conn),
        }
    }

    #[tokio::test]
    async fn dictionary_new_creates_table_and_list_returns_complete_dtos() {
        let (database, directory) = test_database("new-list");
        let store = DictionaryStore::new(database).unwrap();
        {
            let conn = store.conn.lock().unwrap_or_else(|error| error.into_inner());
            conn.execute(
                "INSERT INTO dictionary (word, pronunciation) VALUES (?1, ?2)",
                rusqlite::params!["EcholIKE", "echo-like"],
            )
            .unwrap();
        }

        let entries = store.list().await.unwrap();

        assert_eq!(entries.len(), 1);
        assert!(entries[0].id > 0);
        assert_eq!(entries[0].word, "EcholIKE");
        assert_eq!(entries[0].pronunciation.as_deref(), Some("echo-like"));
        drop(store);
        fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn dictionary_words_skips_rows_that_are_not_text() {
        let store = in_memory_dictionary_store();
        store
            .conn
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .execute_batch(
                "INSERT INTO dictionary (word) VALUES ('first');
                 INSERT INTO dictionary (word) VALUES (x'00');
                 INSERT INTO dictionary (word) VALUES ('last');",
            )
            .unwrap();

        let mut words = store.words().await;
        words.sort();

        assert_eq!(words, vec!["first", "last"]);
    }

    #[tokio::test]
    async fn dictionary_words_returns_empty_when_prepare_or_query_fails() {
        let store = in_memory_dictionary_store();
        store
            .conn
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .execute_batch("DROP TABLE dictionary;")
            .unwrap();
        assert!(store
            .conn
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .prepare("SELECT word FROM dictionary")
            .is_err());
        assert!(store.words().await.is_empty());

        store
            .conn
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .execute_batch(
                "CREATE VIEW dictionary AS
                 SELECT abs(-9223372036854775808) AS word;",
            )
            .unwrap();
        {
            let conn = store.conn.lock().unwrap_or_else(|error| error.into_inner());
            let mut statement = conn.prepare("SELECT word FROM dictionary").unwrap();
            let mut rows = statement.query([]).unwrap();
            assert!(rows.next().is_err());
        }
        assert!(store.words().await.is_empty());
    }
}
