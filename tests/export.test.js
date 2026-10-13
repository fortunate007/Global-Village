const request = require('supertest');
const db = require('../src/db');
const app = require('../src/app');
const posts = require('../src/services/postService');
const engagement = require('../src/services/engagementService');
const safety = require('../src/services/safetyService');
const exportService = require('../src/services/exportService');

const PASSWORD_HASH = 'HASH-OF-THE-EXPORTER-123';

let counter = 0;
function makeUser(name, hash = 'x') {
  counter += 1;
  const username = `${name}_${counter}_ex`;
  const email = `${username}@example.com`;
  const id = Number(
    db
      .prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
      .run(username, email, hash, name).lastInsertRowid
  );
  return { id, username, email };
}

describe('building the export', () => {
  test('contains the person\'s own data in every section, and nobody else\'s private data', () => {
    const a = makeUser('alice', PASSWORD_HASH);
    const b = makeUser('bob');
    const c = makeUser('carol');
    const d = makeUser('dave');
    const e = makeUser('erin');
    const f = makeUser('frank');
    const g = makeUser('gina');

    // posts, edits, replies, quotes, reposts, likes, bookmarks
    const bobPost = posts.createPost(b.id, 'bob wrote this');
    posts.createPost(b.id, 'bob unrelated secret');
    const first = posts.createPost(a.id, 'first draft');
    posts.editPost(a.id, first, 'first final');
    posts.reply(a.id, bobPost, 'my reply');
    posts.quote(a.id, bobPost, 'my quote');
    posts.toggleRepost(a.id, bobPost);
    engagement.toggleLike(a.id, bobPost);
    engagement.toggleBookmark(a.id, bobPost);
    engagement.toggleLike(b.id, first); // gives alice a notification

    // friends, requests, blocks, mutes (and gina blocking alice, which must stay private)
    const addFriend = db.prepare('INSERT INTO friends (user_id, friend_id) VALUES (?, ?)');
    addFriend.run(a.id, b.id);
    addFriend.run(b.id, a.id);
    const request = db.prepare('INSERT INTO friend_requests (sender_id, recipient_id) VALUES (?, ?)');
    request.run(c.id, a.id);
    request.run(a.id, d.id);
    safety.block(a.id, e.id);
    safety.mute(a.id, f.id);
    safety.block(g.id, a.id);

    // direct messages, including a deleted one and an unrelated conversation between others
    const dm = db.prepare('INSERT INTO messages (sender_id, recipient_id, body, image_url) VALUES (?, ?, ?, ?)');
    dm.run(a.id, b.id, 'hi bob', null);
    dm.run(b.id, a.id, 'hi alice', '/uploads/chat/pic.png');
    const deletedId = Number(dm.run(a.id, b.id, 'oops', null).lastInsertRowid);
    db.prepare("UPDATE messages SET body = '', deleted_at = CURRENT_TIMESTAMP WHERE id = ?").run(deletedId);
    dm.run(b.id, c.id, 'bob and carol private', null);

    // groups: one alice is in, one she is not
    const makeGroup = (name, creator, members) => {
      const id = Number(db.prepare('INSERT INTO groups (name, created_by) VALUES (?, ?)').run(name, creator).lastInsertRowid);
      members.forEach((m) => db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(id, m));
      return id;
    };
    const groupId = makeGroup('Crew', a.id, [a.id, b.id]);
    const otherGroup = makeGroup('Elsewhere', b.id, [b.id]);
    const gm = db.prepare('INSERT INTO messages (sender_id, group_id, body) VALUES (?, ?, ?)');
    gm.run(a.id, groupId, 'group hello');
    gm.run(b.id, groupId, 'bob group secret');
    gm.run(b.id, otherGroup, 'other group secret');

    safety.report(a.id, bobPost, 'spam', 'a note');

    const data = exportService.buildExport(a.id);

    expect(data.format_version).toBe(1);
    expect(data.truncated).toEqual([]);
    expect(data.profile).toMatchObject({ id: a.id, username: a.username, email: a.email, display_name: 'alice' });

    expect(data.posts.map((p) => p.body)).toEqual(['first final', 'my reply', 'my quote']);
    expect(data.posts.find((p) => p.body === 'first final').edited_at).toBeTruthy();
    expect(data.posts.find((p) => p.body === 'my reply').parent_id).toBe(bobPost);
    expect(data.posts.find((p) => p.body === 'my quote').quote_of_id).toBe(bobPost);
    expect(data.post_edit_history).toEqual([{ post_id: first, body: 'first draft', edited_at: expect.any(String) }]);
    expect(data.reposts.map((r) => r.post_id)).toEqual([bobPost]);
    expect(data.likes.map((l) => l.post_id)).toEqual([bobPost]);
    expect(data.bookmarks.map((x) => x.post_id)).toEqual([bobPost]);

    expect(data.friends.map((x) => x.username)).toEqual([b.username]);
    expect(data.friend_requests_received.map((x) => x.from_username)).toEqual([c.username]);
    expect(data.friend_requests_sent.map((x) => x.to_username)).toEqual([d.username]);
    expect(data.blocked_accounts.map((x) => x.username)).toEqual([e.username]);
    expect(data.muted_accounts.map((x) => x.username)).toEqual([f.username]);

    expect(data.direct_messages.map((m) => [m.direction, m.other_username, m.body])).toEqual([
      ['sent', b.username, 'hi bob'],
      ['received', b.username, 'hi alice'],
      ['sent', b.username, ''],
    ]);
    expect(data.direct_messages[1].image_url).toBe('/uploads/chat/pic.png');
    expect(data.direct_messages[2].deleted_at).toBeTruthy();

    expect(data.groups).toHaveLength(1);
    expect(data.groups[0]).toMatchObject({ id: groupId, name: 'Crew' });
    expect(data.groups[0].members).toEqual([a.username, b.username]);
    expect(data.group_messages_sent.map((m) => m.body)).toEqual(['group hello']);

    expect(data.notifications.some((n) => n.type === 'like' && n.from_username === b.username)).toBe(true);
    expect(data.reports_filed).toHaveLength(1);
    expect(data.reports_filed[0]).toMatchObject({ reason: 'spam', details: 'a note', post_id: bobPost, post_body: 'bob wrote this' });

    // nothing private or foreign leaks in
    const text = JSON.stringify(data);
    [
      'password_hash', PASSWORD_HASH, 'is_admin', b.email, c.email, d.email,
      'bob unrelated secret', 'bob group secret', 'other group secret', 'bob and carol private', g.username,
    ].forEach((secret) => expect(text).not.toContain(secret));
  });

  test('long lists are cut at the limit and reported', () => {
    const a = makeUser('alice');
    [1, 2, 3].forEach((i) => posts.createPost(a.id, `limited ${i}`));

    const data = exportService.buildExport(a.id, { limit: 2 });
    expect(data.posts).toHaveLength(2);
    expect(data.truncated).toEqual(['posts']);
  });

  test('unknown accounts give nothing', () => {
    expect(exportService.buildExport(999999)).toBeNull();
  });
});

describe('the download', () => {
  let routeCounter = 0;
  async function makeAccount(name) {
    routeCounter += 1;
    const username = `${name}_${routeCounter}_exroute`;
    const agent = request.agent(app);
    await agent
      .post('/register')
      .type('form')
      .send({
        username,
        email: `${username}@example.com`,
        password: 'secret123',
        confirmPassword: 'secret123',
        displayName: username,
      })
      .expect(302);
    const id = db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
    return { id, username, agent };
  }

  const download = (user, password = 'secret123') =>
    user.agent.post('/account/export').type('form').send({ password });

  test('you must be logged in, for the page and for the download', async () => {
    expect((await request(app).get('/account/export').expect(302)).headers.location).toBe('/login');
    expect((await request(app).post('/account/export').type('form').send({ password: 'x' }).expect(302)).headers.location).toBe('/login');
  });

  test('the page explains what is included and asks for the password', async () => {
    const a = await makeAccount('alice');
    const page = (await a.agent.get('/account/export').expect(200)).text;
    expect(page).toContain('name="password"');
    expect(page).toContain('private messages');
  });

  test('a wrong or missing password returns no data', async () => {
    const a = await makeAccount('alice');

    const wrong = await download(a, 'wrong-password').expect(302);
    expect(wrong.headers.location).toBe('/account/export');
    expect(wrong.headers['content-disposition']).toBeUndefined();

    const missing = await a.agent.post('/account/export').type('form').send({}).expect(302);
    expect(missing.headers.location).toBe('/account/export');
    expect(missing.headers['content-disposition']).toBeUndefined();
  });

  test('the right password downloads a JSON file with private caching headers', async () => {
    const a = await makeAccount('alice');
    const res = await download(a).expect(200);

    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toMatch(
      new RegExp(`^attachment; filename="global-village-data-${a.username}-\\d{4}-\\d{2}-\\d{2}\\.json"$`)
    );

    const data = JSON.parse(res.text);
    expect(data.profile.username).toBe(a.username);
    expect(res.text).not.toContain('password_hash');
  });

  test('you only ever get your own data', async () => {
    const a = await makeAccount('alice');
    const b = await makeAccount('bob');
    posts.createPost(a.id, 'only alice has this post');
    posts.createPost(b.id, 'only bob has this post');

    const res = await download(a).expect(200);
    expect(res.text).toContain('only alice has this post');
    expect(res.text).not.toContain('only bob has this post');
    expect(res.text).not.toContain(b.username);
  });

  test('the deletion page offers a copy first', async () => {
    const a = await makeAccount('alice');
    const page = (await a.agent.get('/account/delete').expect(200)).text;
    expect(page).toContain('/account/export');
  });
});
