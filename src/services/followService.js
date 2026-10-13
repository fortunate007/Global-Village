const db = require('../db');
const safety = require('./safetyService');

class FollowError extends Error {}
exports.FollowError = FollowError;

// People the viewer has blocked, or who blocked the viewer
const HIDDEN = `(
  SELECT blocked_id FROM blocks WHERE blocker_id = @viewer
  UNION SELECT blocker_id FROM blocks WHERE blocked_id = @viewer
)`;

exports.isFollowing = (a, b) =>
  !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(a, b);

exports.follow = (me, targetId) => {
  const target = Number(targetId);
  if (!Number.isInteger(target)) throw new FollowError('User not found.');
  if (target === me) throw new FollowError("You can't follow yourself.");
  const exists = db.prepare('SELECT 1 FROM users WHERE id = ?').get(target);
  // Blocked either way looks exactly like a missing account
  if (!exists || safety.blockedEitherWay(me, target)) throw new FollowError('User not found.');
  const result = db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)').run(me, target);
  return { changed: result.changes > 0 };
};

exports.unfollow = (me, targetId) => {
  const target = Number(targetId);
  if (!Number.isInteger(target)) return { changed: false };
  const result = db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(me, target);
  return { changed: result.changes > 0 };
};

// Used when someone is blocked: drops follows in both directions
exports.removeBetween = (a, b) =>
  db
    .prepare(
      `DELETE FROM follows
       WHERE (follower_id = ? AND followee_id = ?) OR (follower_id = ? AND followee_id = ?)`
    )
    .run(a, b, b, a).changes;

exports.counts = (userId, viewerId) => {
  const params = { id: userId, viewer: viewerId };
  const followers = db
    .prepare(`SELECT COUNT(*) AS n FROM follows WHERE followee_id = @id AND follower_id NOT IN ${HIDDEN}`)
    .get(params).n;
  const following = db
    .prepare(`SELECT COUNT(*) AS n FROM follows WHERE follower_id = @id AND followee_id NOT IN ${HIDDEN}`)
    .get(params).n;
  return { followers, following };
};

exports.profileState = (viewerId, userId) => ({
  ...exports.counts(userId, viewerId),
  isSelf: viewerId === userId,
  iFollow: exports.isFollowing(viewerId, userId),
  followsMe: exports.isFollowing(userId, viewerId),
});

// kind: 'followers' (people who follow userId) or 'following' (people userId follows)
exports.list = (kind, userId, viewerId, limit = 200) => {
  const shown = kind === 'followers' ? 'f.follower_id' : 'f.followee_id';
  const owner = kind === 'followers' ? 'f.followee_id' : 'f.follower_id';
  return db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.status_message,
              EXISTS (SELECT 1 FROM follows x WHERE x.follower_id = @viewer AND x.followee_id = u.id) AS i_follow,
              EXISTS (SELECT 1 FROM follows y WHERE y.follower_id = u.id AND y.followee_id = @viewer) AS follows_me
       FROM follows f JOIN users u ON u.id = ${shown}
       WHERE ${owner} = @id AND u.id NOT IN ${HIDDEN}
       ORDER BY f.created_at DESC, f.rowid DESC
       LIMIT @limit`
    )
    .all({ id: userId, viewer: viewerId, limit });
};
