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

const send = (from, toId, body) => from.agent.post(`/messages/${toId}`).type('form').send({ body });

const dmCount = (a, b) =>
  db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE group_id IS NULL AND
       ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))`
    )
    .get(a, b, b, a).n;

const lastMessage = (senderId, recipientId) =>
  db
    .prepare('SELECT id, body, deleted_at FROM messages WHERE sender_id = ? AND recipient_id = ? ORDER BY id DESC')
    .get(senderId, recipientId);

test('blocked people cannot message each other, the history is closed, and unblocking restores it', async () => {
  const a = await makeUser('alice');
  const b = await makeUser('bob');

  await send(a, b.id, 'hello').expect(302);
  expect(dmCount(a.id, b.id)).toBe(1);

  await a.agent.post(`/safety/block/${b.id}`).expect(302);

  const fromBlocked = await send(b, a.id, 'still there?').expect(302);
  expect(fromBlocked.headers.location).toBe('/users');
  await send(a, b.id, 'no thanks').expect(302);
  expect(dmCount(a.id, b.id)).toBe(1);

  expect((await a.agent.get(`/messages/${b.id}`).expect(302)).headers.location).toBe('/users');
  expect((await b.agent.get(`/messages/${a.id}`).expect(302)).headers.location).toBe('/users');
  await a.agent.get(`/api/messages/${b.id}/since/0`).expect(403);

  await a.agent.post(`/safety/unblock/${b.id}`).expect(302);
  await send(b, a.id, 'back again').expect(302);
  expect(dmCount(a.id, b.id)).toBe(2);
  await a.agent.get(`/messages/${b.id}`).expect(200);
});

test('edits and deletes reach only the people in the conversation, whatever the URL says', async () => {
  const a = await makeUser('alice');
  const b = await makeUser('bob');
  const c = await makeUser('carol');
  await send(a, b.id, 'original').expect(302);
  const msg = lastMessage(a.id, b.id);

  const emit = jest.fn();
  const io = { to: jest.fn(() => ({ emit })) };
  const originalIo = app.get('io');
  app.set('io', io);

  try {
    // The URL names carol, but the message was sent to bob
    const edit = await a.agent.post(`/messages/${c.id}/${msg.id}/edit`).type('form').send({ body: 'edited' }).expect(302);
    expect(edit.headers.location).toBe(`/messages/${b.id}`);
    expect(lastMessage(a.id, b.id).body).toBe('edited');
    expect(io.to.mock.calls.map(([room]) => room).sort()).toEqual([`user:${a.id}`, `user:${b.id}`].sort());

    io.to.mockClear();
    await a.agent.post(`/messages/${c.id}/${msg.id}/delete`).expect(302);
    expect(lastMessage(a.id, b.id).deleted_at).toBeTruthy();
    const rooms = io.to.mock.calls.map(([room]) => room);
    expect(rooms.sort()).toEqual([`user:${a.id}`, `user:${b.id}`].sort());
    expect(rooms).not.toContain(`user:${c.id}`);
  } finally {
    app.set('io', originalIo);
  }
});

test('other people cannot edit or delete your messages', async () => {
  const a = await makeUser('alice');
  const b = await makeUser('bob');
  await send(a, b.id, 'mine').expect(302);
  const msg = lastMessage(a.id, b.id);

  await b.agent.post(`/messages/${a.id}/${msg.id}/edit`).type('form').send({ body: 'hijack' }).expect(302);
  await b.agent.post(`/messages/${a.id}/${msg.id}/delete`).expect(302);
  expect(lastMessage(a.id, b.id)).toMatchObject({ body: 'mine', deleted_at: null });
});

test('blocked people cannot edit old messages, but deleting your own message still works', async () => {
  const a = await makeUser('alice');
  const b = await makeUser('bob');
  await send(a, b.id, 'before the block').expect(302);
  const msg = lastMessage(a.id, b.id);

  await b.agent.post(`/safety/block/${a.id}`).expect(302);

  await a.agent.post(`/messages/${b.id}/${msg.id}/edit`).type('form').send({ body: 'sneaky edit' }).expect(302);
  expect(lastMessage(a.id, b.id).body).toBe('before the block');

  await a.agent.post(`/messages/${b.id}/${msg.id}/delete`).expect(302);
  expect(lastMessage(a.id, b.id).deleted_at).toBeTruthy();
});

test('group messages cannot be edited through the direct-message route', async () => {
  const a = await makeUser('alice');
  const b = await makeUser('bob');
  await a.agent.post('/groups').type('form').send({ name: 'Team', memberIds: String(b.id) }).expect(302);
  const groupId = db.prepare('SELECT id FROM groups WHERE created_by = ? ORDER BY id DESC').get(a.id).id;
  await a.agent.post(`/groups/${groupId}`).type('form').send({ body: 'team message' }).expect(302);
  const msg = db.prepare('SELECT id FROM messages WHERE group_id = ?').get(groupId);

  await a.agent.post(`/messages/${b.id}/${msg.id}/edit`).type('form').send({ body: 'rewritten' }).expect(302);
  expect(db.prepare('SELECT body FROM messages WHERE id = ?').get(msg.id).body).toBe('team message');
});
