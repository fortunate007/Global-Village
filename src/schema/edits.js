module.exports = function applyEditsSchema(db) {
  const columns = db.prepare('PRAGMA table_info(posts)').all().map((c) => c.name);
  if (!columns.includes('edited_at')) db.exec('ALTER TABLE posts ADD COLUMN edited_at DATETIME');

  db.exec(`
    -- Each row is a version of the post that was replaced; edited_at is when it was replaced
    CREATE TABLE IF NOT EXISTS post_edits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      edited_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_post_edits_post ON post_edits(post_id, id);
  `);
};
