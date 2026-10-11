use crate::storage;

#[tauri::command]
pub async fn get_history(
    state: tauri::State<'_, storage::HistoryStore>,
    limit: u32,
    offset: u32,
) -> Result<Vec<storage::HistoryEntry>, String> {
    state.list(limit, offset).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_history_entries(
    state: tauri::State<'_, storage::HistoryStore>,
    ids: Vec<i64>,
) -> Result<Vec<i64>, String> {
    state.delete_entries(&ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_history(
    state: tauri::State<'_, storage::HistoryStore>,
) -> Result<storage::ClearHistoryResult, String> {
    state.clear().map_err(|e| e.to_string())
}
