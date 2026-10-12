const tableSql = (name) => `
  CREATE TABLE ${name} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN
      ('mention', 'reply', 'quote', 'like', 'repost', 'friend_request', 'friend_accept')),
    post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    read_at DATETIME,
    CHECK (user_id != actor_id),
    CHECK ((type IN ('friend_request', 'friend_accept')) = (post_id IS NULL))
  )`;

const TRIGGERS = [
  'notif_like_ai', 'notif_like_ad', 'notif_reply_ai', 'notif_quote_ai', 'notif_repost_ai',
  'notif_repost_ad', 'notif_mention_ai', 'notif_friend_request_ai', 'notif_friend_request_ad',
];

module.exports = function applyNotificationsSchema(db) {
  // Upgrade tables created before friend notifications existed (SQLite cannot alter a CHECK).
  // Triggers are dropped first because ALTER TABLE ... RENAME re-validates them.
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notifications'").get();
  if (existing && !existing.sql.includes('friend_request')) {
    TRIGGERS.forEach((t) => db.exec(`DROP TRIGGER IF EXISTS ${t}`));
    db.transaction(() => {
      db.exec(tableSql('notifications_new'));
      db.exec(`INSERT INTO notifications_new (id, user_id, actor_id, type, post_id, created_at, read_at)
               SELECT id, user_id, actor_id, type, post_id, created_at, read_at FROM notifications`);
      db.exec('DROP TABLE notifications');
      db.exec('ALTER TABLE notifications_new RENAME TO notifications');
    })();
  }

  if (!existing) db.exec(tableSql('notifications'));

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_unique
      ON notifications(user_id, actor_id, type, post_id) WHERE post_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_unique_friend
      ON notifications(user_id, actor_id, type) WHERE post_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_notifications_user
      ON notifications(user_id, read_at, created_at);

    -- Likes: notify the post's author; undoing a like removes the notification
    CREATE TRIGGER IF NOT EXISTS notif_like_ai AFTER INSERT ON likes BEGIN
      INSERT OR IGNORE INTO notifications (user_id, actor_id, type, post_id)
      SELECT p.author_id, new.user_id, 'like', p.id
      FROM posts p WHERE p.id = new.post_id AND p.author_id != new.user_id;
    END;
    CREATE TRIGGER IF NOT EXISTS notif_like_ad AFTER DELETE ON likes BEGIN
      DELETE FROM notifications
      WHERE type = 'like' AND actor_id = old.user_id AND post_id = old.post_id;
    END;

    -- Replies: notify the author of the post being replied to
    CREATE TRIGGER IF NOT EXISTS notif_reply_ai AFTER INSERT ON posts WHEN new.parent_id IS NOT NULL BEGIN
      INSERT OR IGNORE INTO notifications (user_id, actor_id, type, post_id)
      SELECT p.author_id, new.author_id, 'reply', new.id
      FROM posts p WHERE p.id = new.parent_id AND p.author_id != new.author_id;
    END;

    -- Quotes: notify the author of the quoted post
    CREATE TRIGGER IF NOT EXISTS notif_quote_ai AFTER INSERT ON posts WHEN new.quote_of_id IS NOT NULL BEGIN
      INSERT OR IGNORE INTO notifications (user_id, actor_id, type, post_id)
      SELECT p.author_id, new.author_id, 'quote', new.id
      FROM posts p WHERE p.id = new.quote_of_id AND p.author_id != new.author_id;
    END;

    -- Reposts: notify the original author; undoing a repost removes the notification
    CREATE TRIGGER IF NOT EXISTS notif_repost_ai AFTER INSERT ON posts WHEN new.repost_of_id IS NOT NULL BEGIN
      INSERT OR IGNORE INTO notifications (user_id, actor_id, type, post_id)
      SELECT p.author_id, new.author_id, 'repost', p.id
      FROM posts p WHERE p.id = new.repost_of_id AND p.author_id != new.author_id;
    END;
    CREATE TRIGGER IF NOT EXISTS notif_repost_ad AFTER DELETE ON posts WHEN old.repost_of_id IS NOT NULL BEGIN
      DELETE FROM notifications
      WHERE type = 'repost' AND actor_id = old.author_id AND post_id = old.repost_of_id;
    END;

    -- Mentions: notify the mentioned user, unless they already got a reply/quote
    -- notification for the same post (avoids double notifications)
    CREATE TRIGGER IF NOT EXISTS notif_mention_ai AFTER INSERT ON mentions BEGIN
      INSERT OR IGNORE INTO notifications (user_id, actor_id, type, post_id)
      SELECT new.user_id, p.author_id, 'mention', p.id
      FROM posts p
      WHERE p.id = new.post_id
        AND p.author_id != new.user_id
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
          WHERE n.user_id = new.user_id AND n.post_id = new.post_id AND n.type IN ('reply', 'quote')
        );
    END;

    -- Friend requests: notify the recipient
    CREATE TRIGGER IF NOT EXISTS notif_friend_request_ai AFTER INSERT ON friend_requests BEGIN
      INSERT OR IGNORE INTO notifications (user_id, actor_id, type)
      VALUES (new.recipient_id, new.sender_id, 'friend_request');
    END;

    -- Request removed: the recipient's request notification goes away, and if the two
    -- are now friends (the request was accepted) the original sender is told.
    -- The EXISTS checks on users keep this safe when a user account is being deleted.
    CREATE TRIGGER IF NOT EXISTS notif_friend_request_ad AFTER DELETE ON friend_requests BEGIN
      DELETE FROM notifications
      WHERE type = 'friend_request' AND user_id = old.recipient_id AND actor_id = old.sender_id;

      INSERT OR IGNORE INTO notifications (user_id, actor_id, type)
      SELECT old.sender_id, old.recipient_id, 'friend_accept'
      WHERE EXISTS (SELECT 1 FROM users WHERE id = old.sender_id)
        AND EXISTS (SELECT 1 FROM users WHERE id = old.recipient_id)
        AND EXISTS (SELECT 1 FROM friends f WHERE f.user_id = old.sender_id AND f.friend_id = old.recipient_id);
    END;
  `);
};
