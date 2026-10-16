const db = require('../db');
const { POST_SQL, hydrate } = require('./postService');

const PAGE_SIZE = 20;
// Same rule as registration: 3-20 letters, numbers or underscores
const USERNAME_FORMAT = /^[A-Za-z0-9_]{3,20}$/;

exports.PAGE_SIZE = PAGE_SIZE;
exports.USERNAME_FORMAT = USERNAME_FORMAT;

// Only public columns are ever selected (never email, password hash or admin flags).
// Matching ignores letter case, like the unique index on usernames.
exports.findByUsername = (username) => {
  if (typeof username !== 'string' || !USERNAME_FORMAT.test(username)) return null;
  return (
    db
      .prepare(
        `SELECT id, username, display_name, avatar_url, bio, status_message, created_at
         FROM users WHERE username = ? COLLATE NOCASE`
      )
      .get(username) || null
  );
};

exports.postCount = (userId) =>
  db
    .prepare('SELECT COUNT(*) AS n FROM posts WHERE author_id = ? AND parent_id IS NULL AND repost_of_id IS NULL')
    .get(userId).n;

// One page of a person's posts, newest first. kind 'posts' = posts, quotes and reposts; 'replies' = replies.
// before is the id the previous page ended with (a page needs only the ids, not an offset, so it stays
// correct while new posts arrive). lastId is the last row of the page BEFORE any hiding, for the next link.
exports.postsByAuthor = (authorId, { kind = 'posts', before = null, limit = PAGE_SIZE } = {}) => {
  const where = kind === 'replies' ? 'p.parent_id IS NOT NULL' : 'p.parent_id IS NULL';
  const params = [authorId];
  let cursor = '';
  if (Number.isInteger(before) && before > 0) {
    cursor = ' AND p.id < ?';
    params.push(before);
  }

  const found = db
    .prepare(`${POST_SQL} WHERE p.author_id = ? AND ${where}${cursor} ORDER BY p.id DESC LIMIT ?`)
    .all(...params, limit + 1);

  const page = found.slice(0, limit);
  return {
    rows: page.map(hydrate),
    hasMore: found.length > limit,
    lastId: page.length ? page[page.length - 1].id : null,
  };
};

// How the viewer stands with this person, for the buttons on the page
exports.relationship = (viewerId, targetId) => {
  const has = (sql, ...params) => !!db.prepare(sql).get(...params);
  return {
    isFriend: has('SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?', viewerId, targetId),
    requestSent: has('SELECT 1 FROM friend_requests WHERE sender_id = ? AND recipient_id = ?', viewerId, targetId),
    requestReceived: has('SELECT 1 FROM friend_requests WHERE sender_id = ? AND recipient_id = ?', targetId, viewerId),
    isMuted: has('SELECT 1 FROM mutes WHERE muter_id = ? AND muted_id = ?', viewerId, targetId),
  };
};
