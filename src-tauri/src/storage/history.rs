use anyhow::Result;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

/// Maximum number of history entries to retain. Older entries are pruned on insert.
const MAX_HISTORY_ENTRIES: u32 = 5000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: i64,
    pub created_at: String,
    pub app_name: String,
    pub app_type: String,
    pub raw_text: String,
    pub polished_text: String,
    pub language: Option<String>,
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearHistoryResult {
    pub cleared_through_id: i64,
}

pub struct HistoryStore {
    conn: Mutex<Connection>,
}

impl HistoryStore {
    pub fn new(db_path: PathBuf) -> Result<Self> {
        let conn = Connection::open(&db_path)?;
        Self::from_connection(conn)
    }

    fn from_connection(conn: Connection) -> Result<Self> {
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                app_name TEXT NOT NULL DEFAULT '',
                app_type TEXT NOT NULL DEFAULT '',
                raw_text TEXT NOT NULL DEFAULT '',
                polished_text TEXT NOT NULL DEFAULT '',
                language TEXT,
                duration_ms INTEGER
            );",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn add(&self, entry: HistoryEntry) -> Result<()> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "INSERT INTO history (created_at, app_name, app_type, raw_text, polished_text, language, duration_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                entry.created_at,
                entry.app_name,
                entry.app_type,
                entry.raw_text,
                entry.polished_text,
                entry.language,
                entry.duration_ms,
            ],
        )?;

        // Prune old entries beyond the retention limit
        conn.execute(
            "DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT ?1)",
            rusqlite::params![MAX_HISTORY_ENTRIES],
        )?;

        Ok(())
    }

    pub async fn list(&self, limit: u32, offset: u32) -> Result<Vec<HistoryEntry>> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = conn.prepare(
            "SELECT id, created_at, app_name, app_type, raw_text, polished_text, language, duration_ms
             FROM history ORDER BY id DESC LIMIT ?1 OFFSET ?2"
        )?;
        let rows = stmt.query_map(rusqlite::params![limit, offset], |row| {
            Ok(HistoryEntry {
                id: row.get(0)?,
                created_at: row.get(1)?,
                app_name: row.get(2)?,
                app_type: row.get(3)?,
                raw_text: row.get(4)?,
                polished_text: row.get(5)?,
                language: row.get(6)?,
                duration_ms: row.get(7)?,
            })
        })?;
        let mut entries = Vec::new();
        for row in rows {
            entries.push(row?);
        }
        Ok(entries)
    }

    pub fn delete_entries(&self, ids: &[i64]) -> Result<Vec<i64>> {
        let ids = ids
            .iter()
            .copied()
            .filter(|id| *id > 0)
            .collect::<std::collections::BTreeSet<_>>();
        if ids.is_empty() {
            return Ok(Vec::new());
        }

        let mut conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let transaction =
            conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut deleted_ids = Vec::with_capacity(ids.len());
        {
            let mut delete = transaction.prepare_cached("DELETE FROM history WHERE id = ?1")?;
            for id in ids {
                if delete.execute(rusqlite::params![id])? == 1 {
                    deleted_ids.push(id);
                }
            }
        }
        transaction.commit()?;
        Ok(deleted_ids)
    }

    pub fn clear(&self) -> Result<ClearHistoryResult> {
        let mut conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let transaction =
            conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let cleared_through_id =
            transaction.query_row("SELECT COALESCE(MAX(id), 0) FROM history", [], |row| {
                row.get(0)
            })?;
        transaction.execute(
            "DELETE FROM history WHERE id <= ?1",
            rusqlite::params![cleared_through_id],
        )?;
        transaction.commit()?;
        Ok(ClearHistoryResult { cleared_through_id })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn in_memory_history_store() -> HistoryStore {
        HistoryStore::from_connection(Connection::open_in_memory().unwrap()).unwrap()
    }

    fn append_history(store: &HistoryStore, text: &str) -> i64 {
        store
            .add(HistoryEntry {
                id: 0,
                created_at: "2026-07-31T00:00:00Z".to_string(),
                app_name: "test".to_string(),
                app_type: "test".to_string(),
                raw_text: text.to_string(),
                polished_text: text.to_string(),
                language: None,
                duration_ms: None,
            })
            .unwrap();
        store
            .conn
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .last_insert_rowid()
    }

    fn stored_history_ids(store: &HistoryStore) -> Vec<i64> {
        let conn = store.conn.lock().unwrap_or_else(|error| error.into_inner());
        let mut statement = conn.prepare("SELECT id FROM history ORDER BY id").unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    #[test]
    fn history_batch_delete_deduplicates_ids_and_returns_only_deleted_rows() {
        let store = in_memory_history_store();
        let first = append_history(&store, "first");
        let second = append_history(&store, "second");
        let third = append_history(&store, "third");

        let deleted = store
            .delete_entries(&[third, -1, first, third, 0, i64::MAX])
            .unwrap();

        assert_eq!(deleted, vec![first, third]);
        assert_eq!(stored_history_ids(&store), vec![second]);
    }

    #[test]
    fn history_batch_delete_rolls_back_the_whole_selection_on_failure() {
        let store = in_memory_history_store();
        let first = append_history(&store, "first");
        let second = append_history(&store, "second");
        store
            .conn
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .execute_batch(
                "CREATE TRIGGER reject_second_history_delete
                 BEFORE DELETE ON history
                 WHEN OLD.raw_text = 'second'
                 BEGIN
                     SELECT RAISE(ABORT, 'injected delete failure');
                 END;",
            )
            .unwrap();

        assert!(store.delete_entries(&[first, second]).is_err());
        assert_eq!(stored_history_ids(&store), vec![first, second]);
    }

    #[test]
    fn history_clear_returns_floor_and_preserves_entries_added_afterward() {
        let store = in_memory_history_store();
        append_history(&store, "first");
        let floor = append_history(&store, "second");

        let result = store.clear().unwrap();
        assert_eq!(
            result,
            ClearHistoryResult {
                cleared_through_id: floor
            }
        );
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            serde_json::json!({ "clearedThroughId": floor })
        );
        assert!(stored_history_ids(&store).is_empty());

        let later = append_history(&store, "later");
        assert!(later > floor);
        assert_eq!(stored_history_ids(&store), vec![later]);
    }

    #[test]
    fn history_clear_reports_zero_for_an_empty_store() {
        let store = in_memory_history_store();

        assert_eq!(
            store.clear().unwrap(),
            ClearHistoryResult {
                cleared_through_id: 0
            }
        );
    }

    #[tokio::test]
    async fn history_list_is_newest_first_and_honors_limit_and_offset() {
        let store = in_memory_history_store();
        let first = append_history(&store, "first");
        let second = append_history(&store, "second");
        let third = append_history(&store, "third");

        let entries = store.list(2, 1).await.unwrap();

        assert_eq!(
            entries.iter().map(|entry| entry.id).collect::<Vec<_>>(),
            vec![second, first]
        );
        assert_eq!(entries[0].raw_text, "second");
        assert!(third > entries[0].id);
    }
}
