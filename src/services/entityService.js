const db = require('../db');
const { HASHTAG, MENTION } = require('../utils/linkify');

const MAX_PER_POST = 10;

const upsertTag = db.prepare('INSERT INTO hashtags (tag) VALUES (?) ON CONFLICT(tag) DO NOTHING');
const getTag = db.prepare('SELECT id FROM hashtags WHERE tag = ?');
const linkTag = db.prepare('INSERT OR IGNORE INTO post_hashtags (post_id, hashtag_id) VALUES (?, ?)');
const linkMention = db.prepare('INSERT OR IGNORE INTO mentions (post_id, user_id) VALUES (?, ?)');

const extract = (re, text, normalize = (x) => x) =>
  [...new Set([...text.matchAll(re)].map((m) => normalize(m[2])))].slice(0, MAX_PER_POST);

// Call inside the transaction that creates the post
exports.sync = (postId, body) => {
  if (!body) return;

  for (const tag of extract(HASHTAG, body, (t) => t.toLowerCase())) {
    upsertTag.run(tag);
    linkTag.run(postId, getTag.get(tag).id);
  }

  const names = extract(MENTION, body);
  if (names.length) {
    const marks = names.map(() => '?').join(',');
    db.prepare(`SELECT id FROM users WHERE username COLLATE NOCASE IN (${marks})`)
      .all(...names)
      .forEach((u) => linkMention.run(postId, u.id));
  }
};

// Rebuilds a post's hashtags and mentions after its text changed. People who are still
// mentioned keep their existing notification (and its read state); removed ones lose it.
exports.resync = (postId, body) => {
  const previousTags = db.prepare('SELECT hashtag_id FROM post_hashtags WHERE post_id = ?').all(postId);

  db.prepare('DELETE FROM post_hashtags WHERE post_id = ?').run(postId);
  db.prepare('DELETE FROM mentions WHERE post_id = ?').run(postId);
  exports.sync(postId, body);

  db.prepare(
    `DELETE FROM notifications
     WHERE type = 'mention' AND post_id = ?
       AND user_id NOT IN (SELECT user_id FROM mentions WHERE post_id = ?)`
  ).run(postId, postId);

  // Drop hashtags that no longer have any post
  const dropOrphan = db.prepare(
    'DELETE FROM hashtags WHERE id = ? AND NOT EXISTS (SELECT 1 FROM post_hashtags WHERE hashtag_id = ?)'
  );
  previousTags.forEach((t) => dropOrphan.run(t.hashtag_id, t.hashtag_id));
};
