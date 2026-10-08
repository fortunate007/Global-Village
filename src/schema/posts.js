module.exports = function applyPostsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT,
      parent_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      repost_of_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      quote_of_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      CHECK (
        (repost_of_id IS NOT NULL AND body IS NULL AND parent_id IS NULL AND quote_of_id IS NULL) OR
        (repost_of_id IS NULL AND body IS NOT NULL)
      )
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_one_repost
      ON posts(author_id, repost_of_id) WHERE repost_of_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_posts_parent ON posts(parent_id);
    CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id);
    CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
  `);
};
