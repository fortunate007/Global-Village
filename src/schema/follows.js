module.exports = function applyFollowsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS follows (
      follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (follower_id, followee_id),
      CHECK (follower_id != followee_id)
    );
    CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id, created_at);
  `);
};
