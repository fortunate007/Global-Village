const db = require('../db');

const MAX_LENGTH = 280;

// Errors safe to show to the user (anything else goes to the Express error handler)
class PostError extends Error {}

const POST_SQL = `
  SELECT p.id, p.author_id, p.body, p.parent_id, p.repost_of_id, p.quote_of_id, p.created_at,
         u.username, u.display_name, u.avatar_url,
         (SELECT COUNT(*) FROM posts x WHERE x.parent_id = p.id) AS reply_count,
         (SELECT COUNT(*) FROM posts x WHERE x.repost_of_id = p.id) AS repost_count,
         (SELECT COUNT(*) FROM posts x WHERE x.quote_of_id = p.id) AS quote_count
  FROM posts p
  JOIN users u ON u.id = p.author_id`;

const insert = db.prepare(
  'INSERT INTO posts (author_id, body, parent_id, repost_of_id, quote_of_id) VALUES (?, ?, ?, ?, ?)'
);

function clean(body) {
  const text = (body || '').trim();
  if (!text) throw new PostError('Post cannot be empty.');
  if (text.length > MAX_LENGTH) throw new PostError(`Posts are limited to ${MAX_LENGTH} characters.`);
  return text;
}

function requirePost(id) {
  const row = db.prepare('SELECT id, author_id, repost_of_id FROM posts WHERE id = ?').get(id);
  if (!row) throw new PostError('Post not found.');
  return row;
}

const getPost = (id) => db.prepare(`${POST_SQL} WHERE p.id = ?`).get(id);

// Attach the original (for reposts) and the quoted post (for quotes)
function hydrate(row) {
  if (!row) return row;
  if (row.repost_of_id) row.original = hydrate(getPost(row.repost_of_id));
  if (row.quote_of_id) row.quoted = getPost(row.quote_of_id);
  return row;
}

exports.PostError = PostError;
exports.MAX_LENGTH = MAX_LENGTH;

exports.createPost = (authorId, body) =>
  Number(insert.run(authorId, clean(body), null, null, null).lastInsertRowid);

exports.reply = (authorId, parentId, body) => {
  requirePost(parentId);
  return Number(insert.run(authorId, clean(body), parentId, null, null).lastInsertRowid);
};

exports.quote = (authorId, quotedId, body) => {
  requirePost(quotedId);
  return Number(insert.run(authorId, clean(body), null, null, quotedId).lastInsertRowid);
};

// Reposts always point at the original post. Returns { reposted: true|false }
exports.toggleRepost = (authorId, postId) => {
  const target = requirePost(postId);
  const originalId = target.repost_of_id || target.id;
  const existing = db
    .prepare('SELECT id FROM posts WHERE author_id = ? AND repost_of_id = ?')
    .get(authorId, originalId);
  if (existing) {
    db.prepare('DELETE FROM posts WHERE id = ?').run(existing.id);
    return { reposted: false };
  }
  insert.run(authorId, null, null, originalId, null);
  return { reposted: true };
};

exports.deletePost = (userId, id) => {
  const row = requirePost(id);
  if (row.author_id !== userId) throw new PostError('You can only delete your own posts.');
  db.prepare('DELETE FROM posts WHERE id = ?').run(id);
};

// Latest top-level posts and reposts (replies live inside threads)
exports.feed = (limit = 50) =>
  db
    .prepare(`${POST_SQL} WHERE p.parent_id IS NULL ORDER BY p.created_at DESC, p.id DESC LIMIT ?`)
    .all(limit)
    .map(hydrate);

exports.getThread = (id) => {
  const post = hydrate(getPost(id));
  if (!post) return null;

  const ancestors = db
    .prepare(
      `WITH RECURSIVE chain(id, parent_id, depth) AS (
         SELECT id, parent_id, 0 FROM posts WHERE id = ?
         UNION ALL
         SELECT p.id, p.parent_id, c.depth + 1 FROM posts p JOIN chain c ON p.id = c.parent_id
       )
       ${POST_SQL} JOIN chain c ON c.id = p.id
       WHERE c.depth > 0
       ORDER BY c.depth DESC`
    )
    .all(id);

  const replies = db
    .prepare(`${POST_SQL} WHERE p.parent_id = ? ORDER BY p.created_at ASC, p.id ASC LIMIT 100`)
    .all(id)
    .map(hydrate);

  return { post, ancestors, replies };
};
