set -e
[ -f src/db.js ] && [ -f src/app.js ] || { echo "Run this from the Global-Village project root"; exit 1; }

# 1. Remove the broken requires and the unused Prisma leftover
sed -i "/routes\/posts/d; /lib\/linkify/d; /routes\/tags/d" src/app.js
git rm -q --ignore-unmatch lib/prisma.js
rmdir lib 2>/dev/null || true

mkdir -p src/schema src/services views/posts views/partials

# 2. Schema (hooked into db.js just before it exports)
cat > src/schema/posts.js <<'EOF'
module.exports = function applyPostsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT,
      parent_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      repost_of_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      quote_of_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      CHECK (
        (repost_of_id IS NOT NULL AND body IS NULL AND parent_id IS NULL AND quote_of_id IS NULL) OR
        (repost_of_id IS NULL AND body IS NOT NULL)
      )
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_one_repost
      ON posts(author_id, repost_of_id) WHERE repost_of_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_posts_parent ON posts(parent_id);
    CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id);
    CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
  `);
};
EOF
grep -q "schema/posts" src/db.js || sed -i "s|^module.exports = db;|require('./schema/posts')(db);\n\nmodule.exports = db;|" src/db.js

# 3. Service
cat > src/services/postService.js <<'EOF'
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
EOF

# 4. Routes
cat > src/routes/posts.js <<'EOF'
const express = require('express');
const posts = require('../services/postService');

const router = express.Router();

const ensureAuth = (req, res, next) => (req.isAuthenticated() ? next() : res.redirect('/login'));

// Runs a service call; user-facing errors become flash messages, others hit the error handler
const action = (fn, redirectTo) => (req, res, next) => {
  try {
    const result = fn(req);
    res.redirect(redirectTo ? redirectTo(result, req) : 'back');
  } catch (err) {
    if (err instanceof posts.PostError) {
      req.flash('error', err.message);
      return res.redirect('back');
    }
    next(err);
  }
};

router.get('/', (req, res) => {
  res.render('posts/index', { title: 'Posts', feed: posts.feed(), maxLength: posts.MAX_LENGTH });
});

router.get('/:id(\\d+)', (req, res) => {
  const thread = posts.getThread(Number(req.params.id));
  if (!thread) return res.status(404).render('404', { title: 'Not Found' });
  if (thread.post.repost_of_id) return res.redirect(`/posts/${thread.post.repost_of_id}`);
  res.render('posts/show', { title: 'Post', ...thread, maxLength: posts.MAX_LENGTH });
});

router.post('/', ensureAuth, action((req) => posts.createPost(req.user.id, req.body.body), () => '/posts'));
router.post(
  '/:id(\\d+)/reply',
  ensureAuth,
  action((req) => posts.reply(req.user.id, Number(req.params.id), req.body.body), (_r, req) => `/posts/${req.params.id}`)
);
router.post(
  '/:id(\\d+)/quote',
  ensureAuth,
  action((req) => posts.quote(req.user.id, Number(req.params.id), req.body.body), (newId) => `/posts/${newId}`)
);
router.post('/:id(\\d+)/repost', ensureAuth, action((req) => posts.toggleRepost(req.user.id, Number(req.params.id))));
router.post(
  '/:id(\\d+)/delete',
  ensureAuth,
  action((req) => posts.deletePost(req.user.id, Number(req.params.id)), () => '/posts')
);

module.exports = router;
EOF
sed -i "/routes\/groups/a app.use('/posts', require('./routes/posts'));" src/app.js

# 5. Views (all output is HTML-escaped with <%= %>)
cat > views/partials/post-card.ejs <<'EOF'
<article class="post">
  <img src="<%= p.avatar_url %>" alt="" width="40" height="40">
  <strong><%= p.display_name %></strong>
  <small>@<%= p.username %> · <%= new Date(p.created_at + 'Z').toLocaleString() %></small>
  <% if (p.body) { %><p><%= p.body %></p><% } %>
  <% if (p.quoted) { %>
    <blockquote>
      <strong><%= p.quoted.display_name %></strong> <small>@<%= p.quoted.username %></small>
      <p><%= p.quoted.body %></p>
      <a href="/posts/<%= p.quoted.id %>">View post</a>
    </blockquote>
  <% } %>
  <small>
    <a href="/posts/<%= p.id %>">Thread</a> ·
    <%= p.reply_count %> replies · <%= p.repost_count %> reposts · <%= p.quote_count %> quotes
  </small>
</article>
EOF

cat > views/posts/index.ejs <<'EOF'
<%- include('../partials/header') %>
<main>
  <h2>Posts</h2>

  <% if (currentUser) { %>
    <form method="POST" action="/posts">
      <textarea name="body" maxlength="<%= maxLength %>" required placeholder="What's happening?"></textarea>
      <button>Post</button>
    </form>
  <% } else { %>
    <p><a href="/login">Log in</a> to post.</p>
  <% } %>

  <% if (!feed.length) { %><p>No posts yet.</p><% } %>
  <% feed.forEach(row => { %>
    <% if (row.original) { %>
      <small>↻ @<%= row.username %> reposted</small>
      <%- include('../partials/post-card', { p: row.original }) %>
    <% } else { %>
      <%- include('../partials/post-card', { p: row }) %>
    <% } %>
  <% }) %>
</main>
<%- include('../partials/footer') %>
EOF

cat > views/posts/show.ejs <<'EOF'
<%- include('../partials/header') %>
<main>
  <p><a href="/posts">← All posts</a></p>

  <% ancestors.forEach(a => { %>
    <%- include('../partials/post-card', { p: a }) %><hr>
  <% }) %>

  <%- include('../partials/post-card', { p: post }) %>

  <% if (currentUser) { %>
    <form method="POST" action="/posts/<%= post.id %>/repost" style="display:inline"><button>Repost / undo</button></form>
    <% if (currentUser.id === post.author_id) { %>
      <form method="POST" action="/posts/<%= post.id %>/delete" style="display:inline"><button>Delete</button></form>
    <% } %>

    <form method="POST" action="/posts/<%= post.id %>/reply">
      <textarea name="body" maxlength="<%= maxLength %>" required placeholder="Reply"></textarea>
      <button>Reply</button>
    </form>
    <form method="POST" action="/posts/<%= post.id %>/quote">
      <textarea name="body" maxlength="<%= maxLength %>" required placeholder="Add a comment and quote"></textarea>
      <button>Quote</button>
    </form>
  <% } %>

  <h3>Replies</h3>
  <% if (!replies.length) { %><p>No replies yet.</p><% } %>
  <% replies.forEach(r => { %><%- include('../partials/post-card', { p: r }) %><% }) %>
</main>
<%- include('../partials/footer') %>
EOF

# 6. Verify, then commit
npm test || { echo "Tests failed - not committing"; exit 1; }
git add -A
git commit -m "feat(posts): add posts, replies, reposts, quotes and threads; remove broken requires"
echo "Done. Start the app and visit /posts"
