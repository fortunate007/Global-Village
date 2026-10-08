module.exports = function applySearchSchema(db) {
  const existed = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'posts_fts'").get();

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
      body,
      content='posts',
      content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS posts_fts_ai AFTER INSERT ON posts WHEN new.body IS NOT NULL BEGIN
      INSERT INTO posts_fts(rowid, body) VALUES (new.id, new.body);
    END;

    CREATE TRIGGER IF NOT EXISTS posts_fts_ad AFTER DELETE ON posts WHEN old.body IS NOT NULL BEGIN
      INSERT INTO posts_fts(posts_fts, rowid, body) VALUES ('delete', old.id, old.body);
    END;

    CREATE TRIGGER IF NOT EXISTS posts_fts_au AFTER UPDATE OF body ON posts BEGIN
      INSERT INTO posts_fts(posts_fts, rowid, body) SELECT 'delete', old.id, old.body WHERE old.body IS NOT NULL;
      INSERT INTO posts_fts(rowid, body) SELECT new.id, new.body WHERE new.body IS NOT NULL;
    END;
  `);

  // First run only: index the posts that already exist
  if (!existed) db.exec("INSERT INTO posts_fts(posts_fts) VALUES ('rebuild')");
};
