const db = require('../db');

const WINDOWS = ['-1 days', '-7 days'];

// Authors the viewer has blocked, been blocked by, or muted
const HIDDEN = `(
  SELECT blocked_id FROM blocks WHERE blocker_id = @u
  UNION SELECT blocker_id FROM blocks WHERE blocked_id = @u
  UNION SELECT muted_id FROM mutes WHERE muter_id = @u
)`;

const safe = (fn) => {
  try { return fn(); } catch (err) { console.error('[sidebar]', err.message); return []; }
};

function trends(userId, limit = 5) {
  const stmt = db.prepare(`
    SELECT h.tag AS tag, COUNT(DISTINCT ph.post_id) AS count
    FROM post_hashtags ph
    JOIN hashtags h ON h.id = ph.hashtag_id
    JOIN posts p ON p.id = ph.post_id
    WHERE ph.created_at >= datetime('now', @since)
      AND p.author_id NOT IN ${HIDDEN}
    GROUP BY h.id
    ORDER BY count DESC, MAX(ph.created_at) DESC, h.tag ASC
    LIMIT @limit`);
  for (let i = 0; i < WINDOWS.length; i++) {
    const rows = stmt.all({ u: userId, since: WINDOWS[i], limit });
    if (rows.length >= 3 || i === WINDOWS.length - 1) return rows;
  }
  return [];
}

function popular(userId, limit = 3) {
  const rows = db.prepare(`
    SELECT p.id AS id, p.body AS body, u.display_name AS author, COUNT(l.user_id) AS likes
    FROM posts p
    JOIN users u ON u.id = p.author_id
    JOIN likes l ON l.post_id = p.id
    WHERE p.body IS NOT NULL AND p.parent_id IS NULL
      AND l.created_at >= datetime('now', '-7 days')
      AND p.author_id NOT IN ${HIDDEN}
    GROUP BY p.id
    ORDER BY likes DESC, p.id DESC
    LIMIT @limit`).all({ u: userId, limit });
  return rows.map((r) => {
    const text = String(r.body).replace(/\s+/g, ' ').trim();
    return { id: r.id, author: r.author, likes: r.likes, excerpt: text.length > 80 ? text.slice(0, 77) + '…' : text };
  });
}

function people(userId, limit = 3) {
  return db.prepare(`
    WITH my AS (
      SELECT friend_id AS id FROM friends WHERE user_id = @u
      UNION SELECT user_id FROM friends WHERE friend_id = @u
    )
    SELECT u.id AS id, u.username AS username, u.display_name AS display_name,
           u.avatar_url AS avatar_url, u.status_message AS status_message,
           (SELECT COUNT(*) FROM my WHERE my.id IN (
              SELECT friend_id FROM friends WHERE user_id = u.id
              UNION SELECT user_id FROM friends WHERE friend_id = u.id
           )) AS mutual
    FROM users u
    WHERE u.id != @u
      AND u.id NOT IN (SELECT id FROM my)
      AND u.id NOT IN (SELECT recipient_id FROM friend_requests WHERE sender_id = @u)
      AND u.id NOT IN (SELECT sender_id FROM friend_requests WHERE recipient_id = @u)
      AND u.id NOT IN ${HIDDEN}
    ORDER BY mutual DESC, u.last_seen DESC, u.id ASC
    LIMIT @limit`).all({ u: userId, limit });
}

exports.get = (userId) => {
  if (!userId) return { trends: [], popular: [], people: [] };
  return {
    trends: safe(() => trends(userId)),
    popular: safe(() => popular(userId)),
    people: safe(() => people(userId)),
  };
};

// Computed at most once per request, and only if a view asks for it
exports.lazyFor = (user) => {
  let cache = null;
  return () => { if (!cache) cache = exports.get(user ? user.id : 0); return cache; };
};
