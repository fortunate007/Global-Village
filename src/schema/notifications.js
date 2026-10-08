module.exports = function applyNotificationsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('mention', 'reply', 'quote', 'like', 'repost')),
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      read_at DATETIME,
      CHECK (user_id != actor_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_unique
      ON notifications(user_id, actor_id, type, post_id);
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
  `);
};
