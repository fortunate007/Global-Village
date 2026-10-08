const db = require('../db');
const { POST_SQL, hydrate } = require('./postService');

const PAGE_SIZE = 20;
const MAX_QUERY = 100;
const MAX_TERMS = 10;

const normalize = (q) => String(q || '').trim().slice(0, MAX_QUERY);
const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&');

// Turns free text into a safe FTS5 query. Every word is quoted so FTS5 operators
// (AND, OR, NOT, *, :, parentheses) can never cause a syntax error, "quoted phrases"
// are kept, and the last bare word matches as a prefix (so results appear as you type).
function toMatchQuery(q) {
  const terms = [];
  for (const m of q.matchAll(/"([^"]*)"|([\p{L}\p{N}]+)/gu)) {
    if (m[1] !== undefined) {
      const words = m[1].match(/[\p{L}\p{N}]+/gu);
      if (words) terms.push({ text: `"${words.join(' ')}"`, bare: false });
    } else {
      terms.push({ text: `"${m[2]}"`, bare: true });
    }
  }
  const limited = terms.slice(0, MAX_TERMS);
  const last = limited[limited.length - 1];
  if (last && last.bare) last.text += '*';
  return limited.map((t) => t.text).join(' ');
}

function searchPosts(q, page) {
  const match = toMatchQuery(q);
  if (!match) return { posts: [], hasMore: false };

  const rows = db
    .prepare('SELECT rowid AS id FROM posts_fts WHERE posts_fts MATCH ? ORDER BY rank LIMIT ? OFFSET ?')
    .all(match, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE);

  const hasMore = rows.length > PAGE_SIZE;
  const ids = rows.slice(0, PAGE_SIZE).map((r) => r.id);
  if (!ids.length) return { posts: [], hasMore: false };

  const marks = ids.map(() => '?').join(',');
  const found = db.prepare(`${POST_SQL} WHERE p.id IN (${marks})`).all(...ids).map(hydrate);
  const byId = new Map(found.map((p) => [p.id, p]));
  return { posts: ids.map((id) => byId.get(id)).filter(Boolean), hasMore };
}

// Only public profile columns are selected (never email or password hash)
const searchPeople = (q, limit) =>
  db
    .prepare(
      `SELECT id, username, display_name, avatar_url, bio
       FROM users
       WHERE username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\'
       ORDER BY username
       LIMIT ?`
    )
    .all(`%${escapeLike(q)}%`, `%${escapeLike(q)}%`, limit);

const searchTags = (q, limit) =>
  db
    .prepare(
      `SELECT h.tag AS tag, COUNT(ph.post_id) AS count
       FROM hashtags h
       LEFT JOIN post_hashtags ph ON ph.hashtag_id = h.id
       WHERE h.tag LIKE ? ESCAPE '\\'
       GROUP BY h.id
       ORDER BY count DESC, h.tag ASC
       LIMIT ?`
    )
    .all(`${escapeLike(q.replace(/^#/, '').toLowerCase())}%`, limit);

exports.toMatchQuery = toMatchQuery;
exports.PAGE_SIZE = PAGE_SIZE;

exports.search = (rawQuery, type = 'all', page = 1) => {
  const q = normalize(rawQuery);
  const empty = { q, posts: [], hasMore: false, people: [], tags: [] };
  if (!q) return empty;

  const wants = (t) => type === 'all' || type === t;
  const { posts, hasMore } = wants('posts') ? searchPosts(q, page) : { posts: [], hasMore: false };
  return {
    q,
    posts,
    hasMore,
    people: wants('people') ? searchPeople(q, type === 'all' ? 5 : 30) : [],
    tags: wants('tags') ? searchTags(q, type === 'all' ? 5 : 30) : [],
  };
};
