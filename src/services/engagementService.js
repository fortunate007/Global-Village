const db = require('../db');
const { PostError, POST_SQL, hydrate } = require('./postService');

const TABLES = { like: 'likes', bookmark: 'bookmarks' };

// Toggles a like/bookmark. On a repost, it applies to the original post.
// Returns { active: true } when added, { active: false } when removed.
const toggle = db.transaction((kind, userId, postId) => {
  const table = TABLES[kind];
  const target = db.prepare('SELECT id, repost_of_id FROM posts WHERE id = ?').get(postId);
  if (!target) throw new PostError('Post not found.');
  const id = target.repost_of_id || target.id;

  const removed = db.prepare(`DELETE FROM ${table} WHERE user_id = ? AND post_id = ?`).run(userId, id);
  if (removed.changes) return { active: false };
  db.prepare(`INSERT INTO ${table} (user_id, post_id) VALUES (?, ?)`).run(userId, id);
  return { active: true };
});

exports.toggleLike = (userId, postId) => toggle('like', userId, postId);
exports.toggleBookmark = (userId, postId) => toggle('bookmark', userId, postId);

// Collect every post id shown on a page (including reposted/quoted originals)
exports.collectIds = (...lists) => {
  const ids = new Set();
  const walk = (row) => {
    if (!row) return;
    ids.add(row.id);
    walk(row.original);
    walk(row.quoted);
  };
  lists.flat().forEach(walk);
  return [...ids];
};

// Which of these posts has the viewer liked / bookmarked?
exports.viewerState = (userId, ids) => {
  const state = { likedIds: new Set(), bookmarkedIds: new Set() };
  if (!userId || !ids.length) return state;
  const marks = ids.map(() => '?').join(',');
  for (const [table, set] of [['likes', state.likedIds], ['bookmarks', state.bookmarkedIds]]) {
    db.prepare(`SELECT post_id FROM ${table} WHERE user_id = ? AND post_id IN (${marks})`)
      .all(userId, ...ids)
      .forEach((r) => set.add(r.post_id));
  }
  return state;
};

exports.listBookmarks = (userId, limit = 50) =>
  db
    .prepare(
      `${POST_SQL}
       JOIN bookmarks b ON b.post_id = p.id
       WHERE b.user_id = ?
       ORDER BY b.created_at DESC, b.rowid DESC
       LIMIT ?`
    )
    .all(userId, limit)
    .map(hydrate);
