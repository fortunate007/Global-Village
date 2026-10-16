require('../src/app');
const db = require('../src/db');
const posts = require('../src/services/postService');
const engagement = require('../src/services/engagementService');
const safety = require('../src/services/safetyService');
const sidebar = require('../src/services/sidebarService');

let counter = 0;
function makeUser(name) {
  counter += 1;
  const username = `${name}_${counter}_sb`;
  const id = Number(
    db
      .prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
      .run(username, `${username}@example.com`, 'x', name).lastInsertRowid
  );
  return { id, username };
}

// Each test starts from an empty set of accounts, so the short sidebar lists are predictable
beforeEach(() => db.exec('DELETE FROM follows; DELETE FROM users; DELETE FROM hashtags;'));

const suspend = (id) => db.prepare('UPDATE users SET suspended_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
const unsuspend = (id) => db.prepare('UPDATE users SET suspended_at = NULL WHERE id = ?').run(id);
const peopleIds = (viewer) => sidebar.get(viewer.id).people.map((u) => u.id);

test('suspended accounts are not suggested, and come back when unsuspended', () => {
  const viewer = makeUser('viewer');
  const fine = makeUser('fine');
  const bad = makeUser('bad');
  suspend(bad.id);

  expect(peopleIds(viewer)).toContain(fine.id);
  expect(peopleIds(viewer)).not.toContain(bad.id);

  unsuspend(bad.id);
  expect(peopleIds(viewer)).toContain(bad.id);
});

test('posts by suspended accounts do not feed the trends box', () => {
  const viewer = makeUser('viewer');
  const fine = makeUser('fine');
  const bad = makeUser('bad');
  posts.createPost(fine.id, 'hello #okaytag');
  posts.createPost(bad.id, 'hello #badtag');
  suspend(bad.id);

  const tags = sidebar.get(viewer.id).trends.map((t) => t.tag);
  expect(tags).toContain('okaytag');
  expect(tags).not.toContain('badtag');
});

test('posts by suspended accounts do not feed the popular box', () => {
  const viewer = makeUser('viewer');
  const fine = makeUser('fine');
  const bad = makeUser('bad');
  const liker = makeUser('liker');
  const okPost = posts.createPost(fine.id, 'a fine popular post');
  const badPost = posts.createPost(bad.id, 'a post from a suspended account');
  engagement.toggleLike(liker.id, okPost);
  engagement.toggleLike(liker.id, badPost);
  suspend(bad.id);

  const ids = sidebar.get(viewer.id).popular.map((p) => p.id);
  expect(ids).toContain(okPost);
  expect(ids).not.toContain(badPost);
});

test('blocked and muted accounts are still hidden', () => {
  const viewer = makeUser('viewer');
  const blocked = makeUser('blocked');
  const muted = makeUser('muted');
  const plain = makeUser('plain');
  safety.block(viewer.id, blocked.id);
  safety.mute(viewer.id, muted.id);

  const ids = peopleIds(viewer);
  expect(ids).toContain(plain.id);
  expect(ids).not.toContain(blocked.id);
  expect(ids).not.toContain(muted.id);
});
