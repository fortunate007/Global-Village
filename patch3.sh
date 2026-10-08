set -e
node -e "process.exit(+process.versions.node.split('.')[0] >= 22 ? 0 : 1)" || { echo "Switch to Node 22 first: nvm use 22"; exit 1; }
[ -f src/services/engagementService.js ] || { echo "Apply the posts and likes/bookmarks patches first."; exit 1; }
grep -q "schema/entities" src/db.js && { echo "Hashtags/mentions already applied, aborting"; exit 1; }

mkdir -p src/schema src/services src/routes src/utils views/tags

# 1. Schema, hooked into db.js after the engagement schema
cat > src/schema/entities.js <<'EOF'
module.exports = function applyEntitiesSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hashtags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tag TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS post_hashtags (
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      hashtag_id INTEGER NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (post_id, hashtag_id)
    );
    CREATE INDEX IF NOT EXISTS idx_post_hashtags_tag ON post_hashtags(hashtag_id, created_at);

    CREATE TABLE IF NOT EXISTS mentions (
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (post_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mentions_user ON mentions(user_id, created_at);
  `);
};
EOF
sed -i "s|^require('./schema/engagement')(db);|&\nrequire('./schema/entities')(db);|" src/db.js

# 2. Linkify helper: escapes HTML FIRST, then turns #tags and @mentions into links
cat > src/utils/linkify.js <<'EOF'
// If your profile pages live elsewhere, change this one line.
const PROFILE_PATH = '/users/';

const HASHTAG = /(^|\s)#([\p{L}\p{N}_]{1,50})/gu;
const MENTION = /(^|\s)@([A-Za-z0-9_]{1,30})/g;

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function linkify(text) {
  if (!text) return '';
  return escapeHtml(text)
    .replace(HASHTAG, (_m, pre, tag) => `${pre}<a href="/tags/${encodeURIComponent(tag.toLowerCase())}">#${tag}</a>`)
    .replace(MENTION, (_m, pre, name) => `${pre}<a href="${PROFILE_PATH}${name}">@${name}</a>`);
}

module.exports = { linkify, escapeHtml, HASHTAG, MENTION, PROFILE_PATH };
EOF
grep -q "utils/linkify" src/app.js || sed -i "/app.set('view engine', 'ejs');/a app.locals.linkify = require('./utils/linkify').linkify;" src/app.js

# 3. Entity sync: parse a post body and record its tags and mentions
cat > src/services/entityService.js <<'EOF'
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
EOF

# 4. Post service (replaces the earlier version): post + tags + mentions in one transaction
cat > src/services/postService.js <<'EOF'
const db = require('../db');
const entities = require('./entityService');

const MAX_LENGTH = 280;

// Errors safe to show to the user (anything else goes to the Express error handler)
class PostError extends Error {}

const POST_SQL = `
  SELECT p.id, p.author_id, p.body, p.parent_id, p.repost_of_id, p.quote_of_id, p.created_at,
         u.username, u.display_name, u.avatar_url,
         (SELECT COUNT(*) FROM posts x WHERE x.parent_id = p.id) AS reply_count,
         (SELECT COUNT(*) FROM posts x WHERE x.repost_of_id = p.id) AS repost_count,
         (SELECT COUNT(*) FROM posts x WHERE x.quote_of_id = p.id) AS quote_count,
         (SELECT COUNT(*) FROM likes x WHERE x.post_id = p.id) AS like_count
  FROM posts p
  JOIN users u ON u.id = p.author_id`;

const insert = db.prepare(
  'INSERT INTO posts (author_id, body, parent_id, repost_of_id, quote_of_id) VALUES (?, ?, ?, ?, ?)'
);

const createWithEntities = db.transaction((authorId, body, parentId, quoteOfId) => {
  const id = Number(insert.run(authorId, body, parentId, null, quoteOfId).lastInsertRowid);
  entities.sync(id, body);
  return id;
});

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
exports.POST_SQL = POST_SQL;
exports.hydrate = hydrate;

exports.createPost = (authorId, body) => createWithEntities(authorId, clean(body), null, null);

exports.reply = (authorId, parentId, body) => {
  requirePost(parentId);
  return createWithEntities(authorId, clean(body), parentId, null);
};

exports.quote = (authorId, quotedId, body) => {
  requirePost(quotedId);
  return createWithEntities(authorId, clean(body), null, quotedId);
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
EOF

# 5. Discovery queries: posts by tag, trending tags, posts mentioning a user
cat > src/services/discoveryService.js <<'EOF'
const db = require('../db');
const { POST_SQL, hydrate } = require('./postService');

exports.postsByTag = (tag, limit = 50) =>
  db
    .prepare(
      `${POST_SQL}
       JOIN post_hashtags ph ON ph.post_id = p.id
       JOIN hashtags h ON h.id = ph.hashtag_id
       WHERE h.tag = ?
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ?`
    )
    .all(tag, limit)
    .map(hydrate);

exports.trendingTags = (limit = 10, days = 7) =>
  db
    .prepare(
      `SELECT h.tag AS tag, COUNT(*) AS count
       FROM post_hashtags ph
       JOIN hashtags h ON h.id = ph.hashtag_id
       WHERE ph.created_at >= datetime('now', ?)
       GROUP BY h.id
       ORDER BY count DESC, h.tag ASC
       LIMIT ?`
    )
    .all(`-${days} days`, limit);

exports.postsMentioning = (userId, limit = 50) =>
  db
    .prepare(
      `${POST_SQL}
       JOIN mentions m ON m.post_id = p.id
       WHERE m.user_id = ?
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ?`
    )
    .all(userId, limit)
    .map(hydrate);
EOF

# 6. Routes
cat > src/routes/entities.js <<'EOF'
const express = require('express');
const discovery = require('../services/discoveryService');
const engagement = require('../services/engagementService');

const router = express.Router();

const ensureAuth = (req, res, next) => (req.isAuthenticated() ? next() : res.redirect('/login'));
const TAG_RE = /^[\p{L}\p{N}_]{1,50}$/u;

const viewerFor = (req, items) =>
  engagement.viewerState(req.user && req.user.id, engagement.collectIds(items));

router.get('/tags', (req, res) => {
  res.render('tags/index', { title: 'Trending', tags: discovery.trendingTags() });
});

router.get('/tags/:tag', (req, res) => {
  const tag = req.params.tag.toLowerCase();
  if (!TAG_RE.test(tag)) return res.status(404).render('404', { title: 'Not Found' });
  const items = discovery.postsByTag(tag);
  res.render('tags/show', { title: `#${tag}`, tag, items, ...viewerFor(req, items) });
});

router.get('/mentions', ensureAuth, (req, res) => {
  const items = discovery.postsMentioning(req.user.id);
  res.render('mentions', { title: 'Mentions', items, ...viewerFor(req, items) });
});

module.exports = router;
EOF
grep -q "routes/entities" src/app.js || sed -i "/routes\/bookmarks/a app.use('/', require('./routes/entities'));" src/app.js

# 7. Views (text goes through linkify, which escapes HTML first)
cat > views/partials/post-card.ejs <<'EOF'
<% const liked = locals.likedIds && locals.likedIds.has(p.id); %>
<% const bookmarked = locals.bookmarkedIds && locals.bookmarkedIds.has(p.id); %>
<article class="post">
  <img src="<%= p.avatar_url %>" alt="" width="40" height="40">
  <strong><%= p.display_name %></strong>
  <small>@<%= p.username %> · <%= new Date(p.created_at + 'Z').toLocaleString() %></small>
  <% if (p.body) { %><p><%- linkify(p.body) %></p><% } %>
  <% if (p.quoted) { %>
    <blockquote>
      <strong><%= p.quoted.display_name %></strong> <small>@<%= p.quoted.username %></small>
      <p><%- linkify(p.quoted.body) %></p>
      <a href="/posts/<%= p.quoted.id %>">View post</a>
    </blockquote>
  <% } %>
  <small>
    <a href="/posts/<%= p.id %>">Thread</a> ·
    <%= p.reply_count %> replies · <%= p.repost_count %> reposts · <%= p.quote_count %> quotes
  </small>
  <% if (currentUser) { %>
    <form method="POST" action="/posts/<%= p.id %>/like" style="display:inline">
      <button><%= liked ? 'Unlike' : 'Like' %> (<%= p.like_count %>)</button>
    </form>
    <form method="POST" action="/posts/<%= p.id %>/bookmark" style="display:inline">
      <button><%= bookmarked ? 'Remove bookmark' : 'Bookmark' %></button>
    </form>
  <% } else { %>
    <small><%= p.like_count %> likes</small>
  <% } %>
</article>
EOF

cat > views/tags/index.ejs <<'EOF'
<%- include('../partials/header') %>
<main>
  <h2>Trending this week</h2>
  <% if (!tags.length) { %><p>No hashtags yet. Start one with #something.</p><% } %>
  <ol>
    <% tags.forEach(t => { %>
      <li><a href="/tags/<%= encodeURIComponent(t.tag) %>">#<%= t.tag %></a> · <%= t.count %> posts</li>
    <% }) %>
  </ol>
</main>
<%- include('../partials/footer') %>
EOF

cat > views/tags/show.ejs <<'EOF'
<%- include('../partials/header') %>
<main>
  <p><a href="/tags">← Trending</a></p>
  <h2>#<%= tag %></h2>
  <% if (!items.length) { %><p>No posts with this tag yet.</p><% } %>
  <% items.forEach(p => { %><%- include('../partials/post-card', { p }) %><% }) %>
</main>
<%- include('../partials/footer') %>
EOF

cat > views/mentions.ejs <<'EOF'
<%- include('partials/header') %>
<main>
  <h2>Mentions</h2>
  <% if (!items.length) { %><p>Nobody has mentioned you yet.</p><% } %>
  <% items.forEach(p => { %><%- include('partials/post-card', { p }) %><% }) %>
</main>
<%- include('partials/footer') %>
EOF

# 8. Backfill tags/mentions for posts that already exist (safe to re-run)
node -e "
const db = require('./src/db');
const entities = require('./src/services/entityService');
const rows = db.prepare('SELECT id, body FROM posts WHERE body IS NOT NULL').all();
db.transaction(() => rows.forEach((r) => entities.sync(r.id, r.body)))();
console.log('Backfilled', rows.length, 'existing posts');
"

# 9. Tests
cat > tests/entities.test.js <<'EOF'
const db = require('../src/db');
const posts = require('../src/services/postService');
const discovery = require('../src/services/discoveryService');
const { linkify } = require('../src/utils/linkify');

let alice;
let bob;

beforeAll(() => {
  const insert = db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)');
  alice = Number(insert.run('alice', 'alice@example.com', 'x', 'Alice').lastInsertRowid);
  bob = Number(insert.run('bob', 'bob@example.com', 'x', 'Bob').lastInsertRowid);
});

const tagsOf = (postId) =>
  db
    .prepare('SELECT h.tag FROM post_hashtags ph JOIN hashtags h ON h.id = ph.hashtag_id WHERE ph.post_id = ? ORDER BY h.tag')
    .all(postId)
    .map((r) => r.tag);

const mentionedIn = (postId) =>
  db.prepare('SELECT user_id FROM mentions WHERE post_id = ?').all(postId).map((r) => r.user_id);

test('hashtags are stored lowercase and deduplicated', () => {
  const id = posts.createPost(alice, 'Learning #NodeJS and #nodejs with #SQLite');
  expect(tagsOf(id)).toEqual(['nodejs', 'sqlite']);
});

test('# inside words, urls and @ inside emails are ignored', () => {
  const id = posts.createPost(alice, 'see foo#bar, mail a@b.com or http://x.com/#frag');
  expect(tagsOf(id)).toEqual([]);
  expect(mentionedIn(id)).toEqual([]);
});

test('mentions link existing users case-insensitively and ignore unknown ones', () => {
  const id = posts.createPost(alice, 'hey @BOB and @nobody');
  expect(mentionedIn(id)).toEqual([bob]);
});

test('replies and quotes also record tags', () => {
  const root = posts.createPost(alice, 'root post');
  const reply = posts.reply(bob, root, 'agreed #reply');
  const quote = posts.quote(bob, root, 'quoting #quote');
  expect(tagsOf(reply)).toEqual(['reply']);
  expect(tagsOf(quote)).toEqual(['quote']);
});

test('a post stores at most 10 tags', () => {
  const body = Array.from({ length: 12 }, (_, i) => `#t${i}`).join(' ');
  expect(tagsOf(posts.createPost(alice, body))).toHaveLength(10);
});

test('trending counts posts per tag, and postsByTag finds them', () => {
  const a = posts.createPost(alice, 'one #trendy');
  const b = posts.createPost(bob, 'two #TRENDY');
  expect(discovery.trendingTags()[0]).toEqual({ tag: 'trendy', count: 2 });
  expect(discovery.postsByTag('trendy').map((p) => p.id).sort()).toEqual([a, b].sort());
});

test('postsMentioning returns posts that mention a user', () => {
  const id = posts.createPost(alice, 'ping @bob');
  expect(discovery.postsMentioning(bob).map((p) => p.id)).toContain(id);
});

test('linkify escapes HTML before linking', () => {
  const html = linkify('<b>hi</b> #Tag @bob');
  expect(html).toContain('&lt;b&gt;hi&lt;/b&gt;');
  expect(html).not.toContain('<b>');
  expect(html).toContain('<a href="/tags/tag">#Tag</a>');
  expect(html).toContain('>@bob</a>');
});
EOF

# 10. Verify, then commit
node -e "require('./src/app')" && echo "app loads OK"
npm test || { echo "Tests failed - not committing"; exit 1; }
git add -A
git commit -m "feat(entities): add hashtags, mentions, trending tags and linkified post text"
echo "Done. Post something with #tags and @mentions, then visit /tags and /mentions"
