-- 历史记录
CREATE TABLE IF NOT EXISTS history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    app_name    TEXT NOT NULL,
    app_type    TEXT NOT NULL,
    raw_text    TEXT NOT NULL,
    polished_text TEXT NOT NULL,
    language    TEXT,
    duration_ms INTEGER,
    stt_provider TEXT,
    llm_provider TEXT
);

-- 个人词典
CREATE TABLE IF NOT EXISTS dictionary (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    word          TEXT NOT NULL UNIQUE,
    pronunciation TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    usage_count   INTEGER DEFAULT 0
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_history_created ON history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dictionary_word ON dictionary(word);
