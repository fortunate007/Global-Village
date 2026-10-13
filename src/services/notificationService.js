const db = require('../db');

const VERBS = {
  like: 'liked your post',
  repost: 'reposted your post',
  reply: 'replied to your post',
  quote: 'quoted your post',
  mention: 'mentioned you',
  friend_request: 'sent you a friend request',
  friend_accept: 'accepted your friend request',
  follow: 'started following you',
  follow_back: 'followed you back',
};

// Notifications from people you blocked or muted (or who blocked you) are never shown, counted or pushed
const VISIBLE = `n.actor_id NOT IN (
  SELECT blocked_id FROM blocks WHERE blocker_id = n.user_id
  UNION SELECT blocker_id FROM blocks WHERE blocked_id = n.user_id
  UNION SELECT muted_id FROM mutes WHERE muter_id = n.user_id
)`;

const SELECT = `
  SELECT n.id, n.user_id, n.actor_id, n.type, n.post_id, n.created_at, n.read_at,
         u.username, u.display_name, u.avatar_url, p.body
  FROM notifications n
  JOIN users u ON u.id = n.actor_id
  LEFT JOIN posts p ON p.id = n.post_id`;

function hrefFor(n) {
  if (n.type === 'follow' || n.type === 'follow_back') return '/profile/' + n.actor_id;
  if (n.post_id) return `/posts/${n.post_id}`;
  return n.type === 'friend_request' ? '/friends/requests' : '/friends';
}

const present = (n) => ({ ...n, verb: VERBS[n.type], href: hrefFor(n) });

exports.VERBS = VERBS;

exports.list = (userId, limit = 50) =>
  db
    .prepare(`${SELECT} WHERE n.user_id = ? AND ${VISIBLE} ORDER BY n.created_at DESC, n.id DESC LIMIT ?`)
    .all(userId, limit)
    .map(present);

// Every user's notifications newer than the given id (used by the live relay)
exports.listAfter = (id) =>
  db.prepare(`${SELECT} WHERE n.id > ? AND ${VISIBLE} ORDER BY n.id ASC`).all(id).map(present);

exports.unreadCount = (userId) =>
  db
    .prepare(`SELECT COUNT(*) AS count FROM notifications n WHERE n.user_id = ? AND n.read_at IS NULL AND ${VISIBLE}`)
    .get(userId).count;

exports.markAllRead = (userId) =>
  db
    .prepare('UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND read_at IS NULL')
    .run(userId).changes;
