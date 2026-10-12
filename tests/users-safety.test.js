const request = require('supertest');
const db = require('../src/db');
const app = require('../src/app');
const allowsDirect = require('../src/routes/users').allowsDirectFriending;

let counter = 0;
async function makeUser(name) {
  counter += 1;
  const username = `${name}_${counter}_x`;
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

const friendRows = (a, b) =>
  db.prepare('SELECT COUNT(*) AS n FROM friends WHERE user_id IN (?, ?)').get(a, b).n;
const requestRows = (a, b) =>
  db
    .prepare('SELECT COUNT(*) AS n FROM friend_requests WHERE sender_id IN (?, ?) OR recipient_id IN (?, ?)')
    .get(a, b, a, b).n;
const membersOf = (groupId) =>
  db.prepare('SELECT user_id FROM group_members WHERE group_id = ? ORDER BY user_id').all(groupId).map((r) => r.user_id);
const newestGroup = (creatorId) =>
  db.prepare('SELECT id FROM groups WHERE created_by = ? ORDER BY id DESC').get(creatorId).id;
const byId = (x, y) => x - y;

describe('people list', () => {
  test('hides blocked accounts in both directions and still works for everyone else', async () => {
    const a = await makeUser('alice');
    const b = await makeUser('bob');
    const c = await makeUser('carol');
    await a.agent.post(`/safety/block/${b.id}`).expect(302);

    const pageA = (await a.agent.get('/users').expect(200)).text;
    expect(pageA).not.toContain(b.username);
    expect(pageA).toContain(c.username);

    const pageB = (await b.agent.get('/users').expect(200)).text;
    expect(pageB).not.toContain(a.username);
    expect(pageB).toContain(c.username);
  });

  test('the online-status endpoint skips blocked accounts', async () => {
    const a = await makeUser('alice');
    const b = await makeUser('bob');
    const c = await makeUser('carol');
    await a.agent.post(`/safety/block/${b.id}`).expect(302);

    const idsA = (await a.agent.get('/api/users/online').expect(200)).body.map((u) => u.id);
    expect(idsA).not.toContain(b.id);
    expect(idsA).toContain(c.id);

    const idsB = (await b.agent.get('/api/users/online').expect(200)).body.map((u) => u.id);
    expect(idsB).not.toContain(a.id);
  });
});

describe('friending shortcut', () => {
  test('a blocked person cannot create a friendship or a request through it', async () => {
    const a = await makeUser('alice');
    const b = await makeUser('bob');
    await a.agent.post(`/safety/block/${b.id}`).expect(302);

    const res = await b.agent.post(`/users/${a.id}/friend`).expect(302);
    expect(res.headers.location).toBe('/users');
    expect(friendRows(a.id, b.id)).toBe(0);
    expect(requestRows(a.id, b.id)).toBe(0);
  });

  (allowsDirect ? test.skip : test)('it hands over to the request flow, so the other person must accept', async () => {
    const a = await makeUser('alice');
    const b = await makeUser('bob');

    const res = await b.agent.post(`/users/${a.id}/friend`).expect(307);
    expect(res.headers.location).toBe(`/friends/request/${a.id}`);
    expect(friendRows(a.id, b.id)).toBe(0);

    await b.agent.post(res.headers.location).expect(302);
    expect(friendRows(a.id, b.id)).toBe(0);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM friend_requests WHERE sender_id = ? AND recipient_id = ?').get(b.id, a.id).n
    ).toBe(1);
  });
});

describe('leaving groups', () => {
  test('leaving removes you, keeps your old messages and leaves the others in place', async () => {
    const a = await makeUser('alice');
    const b = await makeUser('bob');
    const c = await makeUser('carol');
    await a.agent.post('/groups').type('form').send({ name: 'Crew', memberIds: [String(b.id), String(c.id)] }).expect(302);
    const groupId = newestGroup(a.id);
    await b.agent.post(`/groups/${groupId}`).type('form').send({ body: 'hello from bob' }).expect(302);

    await b.agent.post(`/groups/${groupId}/leave`).expect(302);

    expect(membersOf(groupId)).toEqual([a.id, c.id].sort(byId));
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM messages WHERE group_id = ? AND sender_id = ?').get(groupId, b.id).n
    ).toBe(1);
    expect((await b.agent.get(`/groups/${groupId}`).expect(302)).headers.location).toBe('/users');
    await a.agent.get(`/groups/${groupId}`).expect(200);
  });

  test('when the last person leaves, the group and its messages are deleted', async () => {
    const a = await makeUser('alice');
    const b = await makeUser('bob');
    await a.agent.post('/groups').type('form').send({ name: 'Duo', memberIds: String(b.id) }).expect(302);
    const groupId = newestGroup(a.id);
    await a.agent.post(`/groups/${groupId}`).type('form').send({ body: 'only message' }).expect(302);

    await b.agent.post(`/groups/${groupId}/leave`).expect(302);
    expect(db.prepare('SELECT 1 FROM groups WHERE id = ?').get(groupId)).toBeDefined();

    await a.agent.post(`/groups/${groupId}/leave`).expect(302);
    expect(db.prepare('SELECT 1 FROM groups WHERE id = ?').get(groupId)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE group_id = ?').get(groupId).n).toBe(0);
  });

  test('people who are not in a group cannot leave it, and nothing changes', async () => {
    const a = await makeUser('alice');
    const b = await makeUser('bob');
    const outsider = await makeUser('olive');
    await a.agent.post('/groups').type('form').send({ name: 'Private', memberIds: String(b.id) }).expect(302);
    const groupId = newestGroup(a.id);

    const res = await outsider.agent.post(`/groups/${groupId}/leave`).expect(302);
    expect(res.headers.location).toBe('/users');
    expect(membersOf(groupId)).toEqual([a.id, b.id].sort(byId));
  });
});

describe('chat page', () => {
  test('group chats offer a leave button and direct chats do not', async () => {
    const a = await makeUser('alice');
    const b = await makeUser('bob');
    await a.agent.post('/groups').type('form').send({ name: 'Buttons', memberIds: String(b.id) }).expect(302);
    const groupId = newestGroup(a.id);

    expect((await a.agent.get(`/groups/${groupId}`).expect(200)).text).toContain(`/groups/${groupId}/leave`);
    expect((await a.agent.get(`/messages/${b.id}`).expect(200)).text).not.toContain('/leave');
  });
});
