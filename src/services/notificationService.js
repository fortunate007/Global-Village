const db = require('../db');

const VERBS = {
  like: 'liked your post',
  repost: 'reposted your post',
  reply: 'replied to your post',
  quote: 'quoted your post',
  mention: 'mentioned you',
  friend_request: 'sent you a friend request',
  friend_accept: 'accepted your friend request',
};

const SELECT = `
  SELECT n.id, n.user_id, n.type, n.post_id, n.created_at, n.read_at,
         u.username, u.display_name, u.avatar_url, p.body
  FROM notifications n
  JOIN users u ON u.id = n.actor_id
  LEFT JOIN posts p ON p.id = n.post_id`;

function hrefFor(n) {
  if (n.post_id) return `/posts/${n.post_id}`;
  return n.type === 'friend_request' ? '/friends/requests' : '/friends';
}

const present = (n) => ({ ...n, verb: VERBS[n.type], href: hrefFor(n) });

exports.VERBS = VERBS;

exports.list = (userId, limit = 50) =>
  db
    .prepare(`${SELECT} WHERE n.user_id = ? ORDER BY n.created_at DESC, n.id DESC LIMIT ?`)
    .all(userId, limit)
    .map(present);

// Every user's notifications newer than the given id (used by the live relay)
exports.listAfter = (id) =>
  db.prepare(`${SELECT} WHERE n.id > ? ORDER BY n.id ASC`).all(id).map(present);

exports.unreadCount = (userId) =>
  db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).n;

exports.markAllRead = (userId) =>
  db
    .prepare('UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND read_at IS NULL')
    .run(userId).changes;
