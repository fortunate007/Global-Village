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
