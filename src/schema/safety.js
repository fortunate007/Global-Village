module.exports = function applySafetySchema(db) {
  const userColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!userColumns.includes('is_admin')) {
    db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS blocks (
      blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (blocker_id, blocked_id),
      CHECK (blocker_id != blocked_id)
    );
    CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id);

    CREATE TABLE IF NOT EXISTS mutes (
      muter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      muted_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (muter_id, muted_id),
      CHECK (muter_id != muted_id)
    );

    -- post_body and post_author_id are snapshots, so a report stays reviewable after its post is deleted
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
      post_author_id INTEGER,
      post_body TEXT,
      reason TEXT NOT NULL CHECK (reason IN ('spam', 'abuse', 'harassment', 'misinformation', 'other')),
      details TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME,
      resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_once
      ON reports(reporter_id, post_id) WHERE post_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);

    -- Blocking removes friendships and pending requests in both directions.
    -- Friends are deleted first so no "accepted" notification is generated.
    CREATE TRIGGER IF NOT EXISTS safety_block_ai AFTER INSERT ON blocks BEGIN
      DELETE FROM friends
      WHERE (user_id = new.blocker_id AND friend_id = new.blocked_id)
         OR (user_id = new.blocked_id AND friend_id = new.blocker_id);
      DELETE FROM friend_requests
      WHERE (sender_id = new.blocker_id AND recipient_id = new.blocked_id)
         OR (sender_id = new.blocked_id AND recipient_id = new.blocker_id);
    END;

    -- Friend requests between blocked people are silently ignored (reveals nothing)
    CREATE TRIGGER IF NOT EXISTS safety_friend_request_bi BEFORE INSERT ON friend_requests
    WHEN EXISTS (
      SELECT 1 FROM blocks b
      WHERE (b.blocker_id = new.sender_id AND b.blocked_id = new.recipient_id)
         OR (b.blocker_id = new.recipient_id AND b.blocked_id = new.sender_id)
    )
    BEGIN SELECT RAISE(IGNORE); END;

    -- Blocked people cannot reply to, quote, repost or like each other's posts (either direction)
    CREATE TRIGGER IF NOT EXISTS safety_reply_bi BEFORE INSERT ON posts
    WHEN new.parent_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM blocks b JOIN posts p ON p.id = new.parent_id
      WHERE (b.blocker_id = p.author_id AND b.blocked_id = new.author_id)
         OR (b.blocker_id = new.author_id AND b.blocked_id = p.author_id)
    )
    BEGIN SELECT RAISE(ABORT, 'blocked'); END;

    CREATE TRIGGER IF NOT EXISTS safety_quote_bi BEFORE INSERT ON posts
    WHEN new.quote_of_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM blocks b JOIN posts p ON p.id = new.quote_of_id
      WHERE (b.blocker_id = p.author_id AND b.blocked_id = new.author_id)
         OR (b.blocker_id = new.author_id AND b.blocked_id = p.author_id)
    )
    BEGIN SELECT RAISE(ABORT, 'blocked'); END;

    CREATE TRIGGER IF NOT EXISTS safety_repost_bi BEFORE INSERT ON posts
    WHEN new.repost_of_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM blocks b JOIN posts p ON p.id = new.repost_of_id
      WHERE (b.blocker_id = p.author_id AND b.blocked_id = new.author_id)
         OR (b.blocker_id = new.author_id AND b.blocked_id = p.author_id)
    )
    BEGIN SELECT RAISE(ABORT, 'blocked'); END;

    CREATE TRIGGER IF NOT EXISTS safety_like_bi BEFORE INSERT ON likes
    WHEN EXISTS (
      SELECT 1 FROM blocks b JOIN posts p ON p.id = new.post_id
      WHERE (b.blocker_id = p.author_id AND b.blocked_id = new.user_id)
         OR (b.blocker_id = new.user_id AND b.blocked_id = p.author_id)
    )
    BEGIN SELECT RAISE(ABORT, 'blocked'); END;
  `);
};
