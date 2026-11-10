import type Database from 'better-sqlite3';

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set<string>(
    db
      .prepare('SELECT name FROM _migrations')
      .all()
      .map((row: any) => row.name)
  );

  const migrations: Array<{ name: string; up: (db: Database.Database) => void }> = [
    {
      name: '001_initial_schema',
      up: (db) => {
        db.exec(`
          -- Conversations table
          CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            timezone TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT NULL
          );

          -- Messages table
          CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('complete', 'interrupted', 'failed')),
            client_request_id TEXT NULL UNIQUE,
            model TEXT NULL,
            provider_response_id TEXT NULL,
            usage_json TEXT NULL,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at);
          CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_request_id ON messages(client_request_id) WHERE client_request_id IS NOT NULL;

          -- Message citations table
          CREATE TABLE IF NOT EXISTS message_citations (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            url TEXT NOT NULL,
            canonical_url TEXT NOT NULL,
            title TEXT NULL,
            start_index INTEGER NULL,
            end_index INTEGER NULL,
            retrieved_at TEXT NOT NULL,
            source_metadata_json TEXT NULL,
            FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_citations_message_id ON message_citations(message_id);

          -- Message sources table (complete set of consulted URLs)
          CREATE TABLE IF NOT EXISTS message_sources (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            url TEXT NOT NULL,
            canonical_url TEXT NOT NULL,
            title TEXT NULL,
            retrieved_at TEXT NOT NULL,
            source_metadata_json TEXT NULL,
            FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_sources_message_id ON message_sources(message_id);

          -- Full-text search on messages
          CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            message_id UNINDEXED,
            content,
            tokenize = 'unicode61'
          );

          -- Triggers for FTS sync
          CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(message_id, content) VALUES (new.id, new.content);
          END;

          CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
            DELETE FROM messages_fts WHERE message_id = old.id;
          END;

          CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
            DELETE FROM messages_fts WHERE message_id = old.id;
            INSERT INTO messages_fts(message_id, content) VALUES (new.id, new.content);
          END;

          -- Search runs table for debugging & audit
          CREATE TABLE IF NOT EXISTS search_runs (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            model TEXT NULL,
            started_at TEXT NOT NULL,
            completed_at TEXT NULL,
            status TEXT NOT NULL,
            search_queries_json TEXT NULL,
            sources_count INTEGER DEFAULT 0,
            error_code TEXT NULL,
            FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
          );
        `);
      },
    },
  ];

  for (const m of migrations) {
    if (!applied.has(m.name)) {
      const applyTx = db.transaction(() => {
        m.up(db);
        db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(
          m.name,
          new Date().toISOString()
        );
      });
      applyTx();
    }
  }
}
