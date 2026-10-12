const request = require('supertest');
const db = require('../src/db');
const app = require('../src/app');

let counter = 0;
async function makeUser(name) {
  counter += 1;
  const username = `${name}${counter}`;
  const agent = request.agent(app);
  await agent
    .post('/register')
    .type('form')
    .send({
      username,
      email: `${username}@example.com`,
      password: 'secret123',
      confirmPassword: 'secret123',
      displayName: name,
    })
    .expect(302);
  const id = db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
  return { id, username, agent };
}

const groupCount = () => db.prepare('SELECT COUNT(*) AS n FROM groups').get().n;
const membersOf = (groupId) =>
  db.prepare('SELECT user_id FROM group_members WHERE group_id = ? ORDER BY user_id').all(groupId).map((r) => r.user_id);
const newestGroup = (creatorId) => db.prepare('SELECT id FROM groups WHERE created_by = ? ORDER BY id DESC').get(creatorId).id;

test('a group with only missing users is refused and nothing half-made is left behind', async () => {
  const a = await makeUser('alice');
  const before = groupCount();

  const res = await a.agent.post('/groups').type('form').send({ name: 'Ghosts', memberIds: '999999' }).expect(302);
  expect(res.headers.location).toBe('/groups/new');
  expect(groupCount()).toBe(before);
});

test('missing and blocked users are skipped, real ones are added', async () => {
  const a = await makeUser('alice');
  const b = await makeUser('bob');
  const c = await makeUser('carol');
  await a.agent.post(`/safety/block/${c.id}`).expect(302);

  const res = await a.agent
    .post('/groups')
    .type('form')
    .send({ name: 'Mixed', memberIds: [String(b.id), String(c.id), '999999'] })
    .expect(302);

  const groupId = newestGroup(a.id);
  expect(res.headers.location).toBe(`/groups/${groupId}`);
  expect(membersOf(groupId)).toEqual([a.id, b.id].sort((x, y) => x - y));
});

test('groups are limited to 50 members', async () => {
  const a = await makeUser('alice');
  const ids = [];
  const insert = db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < 60; i += 1) {
    ids.push(String(insert.run(`bulkuser${counter}_${i}`, `bulk${counter}_${i}@example.com`, 'x', 'Bulk').lastInsertRowid));
  }
  const before = groupCount();

  const res = await a.agent.post('/groups').type('form').send({ name: 'Huge', memberIds: ids }).expect(302);
  expect(res.headers.location).toBe('/groups/new');
  expect(groupCount()).toBe(before);
});

test('the new-group picker does not list blocked people', async () => {
  const a = await makeUser('alice');
  const b = await makeUser('bob');
  const c = await makeUser('carol');
  await a.agent.post(`/safety/block/${b.id}`).expect(302);

  const page = await a.agent.get('/groups/new').expect(200);
  expect(page.text).not.toContain(b.username);
  expect(page.text).toContain(c.username);
});

test('group messages over the length limit are rejected', async () => {
  const a = await makeUser('alice');
  const b = await makeUser('bob');
  await a.agent.post('/groups').type('form').send({ name: 'Limits', memberIds: String(b.id) }).expect(302);
  const groupId = newestGroup(a.id);

  await a.agent.post(`/groups/${groupId}`).type('form').send({ body: 'x'.repeat(2001) }).expect(302);
  expect(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE group_id = ?').get(groupId).n).toBe(0);

  await a.agent.post(`/groups/${groupId}`).type('form').send({ body: 'x'.repeat(2000) }).expect(302);
  expect(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE group_id = ?').get(groupId).n).toBe(1);
});

test('people who are not in a group cannot read or post to it', async () => {
  const a = await makeUser('alice');
  const b = await makeUser('bob');
  const outsider = await makeUser('olive');
  await a.agent.post('/groups').type('form').send({ name: 'Private', memberIds: String(b.id) }).expect(302);
  const groupId = newestGroup(a.id);
  await a.agent.post(`/groups/${groupId}`).type('form').send({ body: 'members only' }).expect(302);

  expect((await outsider.agent.get(`/groups/${groupId}`).expect(302)).headers.location).toBe('/users');
  await outsider.agent.get(`/api/groups/${groupId}/since/0`).expect(403);
  await outsider.agent.post(`/groups/${groupId}`).type('form').send({ body: 'let me in' }).expect(302);
  expect(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE group_id = ?').get(groupId).n).toBe(1);
});

test('messages from blocked people are hidden in groups, for the page and the polling endpoint', async () => {
  const a = await makeUser('alice');
  const b = await makeUser('bob');
  const c = await makeUser('carol');
  await a.agent.post('/groups').type('form').send({ name: 'Trio', memberIds: [String(b.id), String(c.id)] }).expect(302);
  const groupId = newestGroup(a.id);

  const secret = `message-from-bob-${counter}`;
  await b.agent.post(`/groups/${groupId}`).type('form').send({ body: secret }).expect(302);

  expect((await a.agent.get(`/groups/${groupId}`).expect(200)).text).toContain(secret);

  await a.agent.post(`/safety/block/${b.id}`).expect(302);

  expect((await a.agent.get(`/groups/${groupId}`).expect(200)).text).not.toContain(secret);
  expect((await a.agent.get(`/api/groups/${groupId}/since/0`).expect(200)).body).toEqual([]);

  // Carol never blocked anyone, so she still sees it
  expect((await c.agent.get(`/groups/${groupId}`).expect(200)).text).toContain(secret);
  expect((await c.agent.get(`/api/groups/${groupId}/since/0`).expect(200)).body).toHaveLength(1);
});

test('profiles of blocked people look like missing accounts', async () => {
  const a = await makeUser('alice');
  const b = await makeUser('bob');
  const c = await makeUser('carol');
  await a.agent.post(`/safety/block/${b.id}`).expect(302);

  expect((await a.agent.get(`/profile/${b.id}`).expect(302)).headers.location).toBe('/users');
  expect((await b.agent.get(`/profile/${a.id}`).expect(302)).headers.location).toBe('/users');
  await c.agent.get(`/profile/${a.id}`).expect(200);
  expect((await a.agent.get('/profile/999999').expect(302)).headers.location).toBe('/users');
});
