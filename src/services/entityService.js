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
