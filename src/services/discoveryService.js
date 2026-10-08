const db = require('../db');
const { POST_SQL, hydrate } = require('./postService');

exports.postsByTag = (tag, limit = 50) =>
  db
    .prepare(
      `${POST_SQL}
       JOIN post_hashtags ph ON ph.post_id = p.id
       JOIN hashtags h ON h.id = ph.hashtag_id
       WHERE h.tag = ?
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ?`
    )
    .all(tag, limit)
    .map(hydrate);

exports.trendingTags = (limit = 10, days = 7) =>
  db
    .prepare(
      `SELECT h.tag AS tag, COUNT(*) AS count
       FROM post_hashtags ph
       JOIN hashtags h ON h.id = ph.hashtag_id
       WHERE ph.created_at >= datetime('now', ?)
       GROUP BY h.id
       ORDER BY count DESC, h.tag ASC
       LIMIT ?`
    )
    .all(`-${days} days`, limit);

exports.postsMentioning = (userId, limit = 50) =>
  db
    .prepare(
      `${POST_SQL}
       JOIN mentions m ON m.post_id = p.id
       WHERE m.user_id = ?
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ?`
    )
    .all(userId, limit)
    .map(hydrate);
