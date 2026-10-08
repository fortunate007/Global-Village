const db = require('../src/db');
const posts = require('../src/services/postService');
const search = require('../src/services/searchService');

let alice;
let bob;

beforeAll(() => {
  const insert = db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)');
  alice = Number(insert.run('alice', 'alice@example.com', 'x', 'Alice Wonderland').lastInsertRowid);
  bob = Number(insert.run('bob', 'bob@example.com', 'x', 'Bob Builder').lastInsertRowid);
});

const ids = (result) => result.posts.map((p) => p.id);

test('finds posts by word, ignoring case', () => {
  const id = posts.createPost(alice, 'Learning Kubernetes today');
  expect(ids(search.search('kubernetes'))).toContain(id);
});

test('last word matches as a prefix', () => {
  const id = posts.createPost(alice, 'Deploying microservices on Render');
  expect(ids(search.search('deploying micro'))).toContain(id);
});

test('quoted phrases match in order only', () => {
  const inOrder = posts.createPost(alice, 'crimson apple pie');
  const reversed = posts.createPost(alice, 'apple crimson pie');
  const result = ids(search.search('"crimson apple"'));
  expect(result).toContain(inOrder);
  expect(result).not.toContain(reversed);
});

test('diacritics are ignored', () => {
  const id = posts.createPost(alice, 'Coffee at a Nairobi café');
  expect(ids(search.search('cafe'))).toContain(id);
});

test('FTS operators and odd input never throw', () => {
  ['"', 'AND', 'OR', 'NOT', '(', ')', '*', 'a" OR "b', '^', 'col:val', '-', '   ', '#', '%'].forEach((q) => {
    expect(() => search.search(q)).not.toThrow();
  });
});

test('toMatchQuery quotes words and prefixes the last bare word', () => {
  expect(search.toMatchQuery('hello wor')).toBe('"hello" "wor"*');
  expect(search.toMatchQuery('"exact phrase" x')).toBe('"exact phrase" "x"*');
  expect(search.toMatchQuery('')).toBe('');
});

test('empty queries return nothing', () => {
  expect(search.search('')).toEqual({ q: '', posts: [], hasMore: false, people: [], tags: [] });
});

test('reposts are not duplicated in results', () => {
  const id = posts.createPost(alice, 'zebra stripes');
  posts.toggleRepost(bob, id);
  expect(ids(search.search('zebra'))).toEqual([id]);
});

test('deleting a post removes it from the index and keeps the index consistent', () => {
  const id = posts.createPost(alice, 'ephemeral thought');
  expect(ids(search.search('ephemeral'))).toContain(id);
  posts.deletePost(alice, id);
  expect(ids(search.search('ephemeral'))).not.toContain(id);
  expect(() => db.prepare("INSERT INTO posts_fts(posts_fts) VALUES ('integrity-check')").run()).not.toThrow();
});

test('results paginate', () => {
  for (let i = 0; i < 25; i++) posts.createPost(alice, `paginate item ${i}`);
  const first = search.search('paginate', 'posts', 1);
  const second = search.search('paginate', 'posts', 2);
  expect(first.posts).toHaveLength(search.PAGE_SIZE);
  expect(first.hasMore).toBe(true);
  expect(second.posts).toHaveLength(5);
  expect(second.hasMore).toBe(false);
});

test('people search matches username or display name and exposes no private columns', () => {
  const byName = search.search('wonder', 'people').people;
  expect(byName.map((u) => u.id)).toContain(alice);
  expect(byName[0]).not.toHaveProperty('email');
  expect(byName[0]).not.toHaveProperty('password_hash');
  expect(search.search('bob', 'people').people.map((u) => u.id)).toContain(bob);
});

test('LIKE wildcards in the query are treated literally', () => {
  expect(search.search('%', 'people').people).toEqual([]);
  expect(search.search('_', 'people').people).toEqual([]);
});

test('tag search matches by prefix, with or without #', () => {
  posts.createPost(alice, 'indexing things #searchable');
  expect(search.search('#search', 'tags').tags).toEqual([{ tag: 'searchable', count: 1 }]);
  expect(search.search('SEARCH', 'tags').tags[0].tag).toBe('searchable');
});
