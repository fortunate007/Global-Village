const db = require('../db');

exports.VERBS = {
  like: 'liked your post',
  repost: 'reposted your post',
  reply: 'replied to your post',
  quote: 'quoted your post',
  mention: 'mentioned you',
};

exports.list = (userId, limit = 50) =>
  db
    .prepare(
      `SELECT n.id, n.type, n.post_id, n.created_at, n.read_at,
              u.username, u.display_name, u.avatar_url, p.body
       FROM notifications n
       JOIN users u ON u.id = n.actor_id
       JOIN posts p ON p.id = n.post_id
       WHERE n.user_id = ?
       ORDER BY n.created_at DESC, n.id DESC
       LIMIT ?`
    )
    .all(userId, limit);

exports.unreadCount = (userId) =>
  db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).n;

exports.markAllRead = (userId) =>
  db
    .prepare('UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND read_at IS NULL')
    .run(userId).changes;
