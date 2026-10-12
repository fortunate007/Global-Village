const request = require('supertest');
const db = require('../src/db');
const app = require('../src/app');
const { broadcastGroupMessage } = require('../src/services/groupRealtime');

let counter = 0;
async function makeUser(name) {
  counter += 1;
  const username = `${name}_${counter}_live`;
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

const newestGroup = (creatorId) =>
  db.prepare('SELECT id FROM groups WHERE created_by = ? ORDER BY id DESC').get(creatorId).id;

async function makeGroup(creator, members) {
  await creator.agent
    .post('/groups')
    .type('form')
    .send({ name: 'Live', memberIds: members.map((m) => String(m.id)) })
    .expect(302);
  return newestGroup(creator.id);
}

function fakeIo() {
  const emit = jest.fn();
  const io = { to: jest.fn(() => ({ emit })) };
  return { io, emit, rooms: () => io.to.mock.calls.map(([room]) => room).sort() };
}

async function withIo(io, run) {
  const original = app.get('io');
  app.set('io', io);
  try {
    return await run();
  } finally {
    app.set('io', original);
  }
}

const roomsFor = (...users) => users.map((u) => `user:${u.id}`).sort();
const post = (user, groupId, body) =>
  user.agent.post(`/groups/${groupId}`).type('form').send({ body }).expect(302);

test('a new group message is pushed live to every member, including the sender', async () => {
  const a = await makeUser('alice');
  const b = await makeUser('bob');
  const c = await makeUser('carol');
  const groupId = await makeGroup(a, [b, c]);
  const { io, emit, rooms } = fakeIo();

  await withIo(io, () => post(a, groupId, 'hello team'));

  expect(rooms()).toEqual(roomsFor(a, b, c));
  expect(emit).toHaveBeenCalledWith(
    'group:new',
    expect.objectContaining({ group_id: groupId, sender_id: a.id, body: 'hello team', sender_name: a.username })
  );
});

test('people who blocked the sender, or were blocked by them, do not receive the message', async () => {
  const a = await makeUser('alice');
  const b = await makeUser('bob');
  const c = await makeUser('carol');
  const d = await makeUser('dave');
  const groupId = await makeGroup(a, [b, c, d]);
  await c.agent.post(`/safety/block/${a.id}`).expect(302);
  await a.agent.post(`/safety/block/${d.id}`).expect(302);
  const { io, rooms } = fakeIo();

  await withIo(io, () => post(a, groupId, 'only for some'));

  expect(rooms()).toEqual(roomsFor(a, b));
});

test('people who left the group stop receiving its messages', async () => {
  const a = await makeUser('alice');
  const b = await makeUser('bob');
  const c = await makeUser('carol');
  const groupId = await makeGroup(a, [b, c]);
  await b.agent.post(`/groups/${groupId}/leave`).expect(302);
  const { io, rooms } = fakeIo();

  await withIo(io, () => post(a, groupId, 'after bob left'));

  expect(rooms()).toEqual(roomsFor(a, c));
});

test('posting to a group you are not in saves nothing and broadcasts nothing', async () => {
  const a = await makeUser('alice');
  const b = await makeUser('bob');
  const outsider = await makeUser('olive');
  const groupId = await makeGroup(a, [b]);
  const { io } = fakeIo();

  await withIo(io, () => post(outsider, groupId, 'let me in'));

  expect(io.to).not.toHaveBeenCalled();
  expect(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE group_id = ?').get(groupId).n).toBe(0);
});

test('direct messages are never broadcast as group messages, and failures never throw', async () => {
  const a = await makeUser('alice');
  const b = await makeUser('bob');
  await a.agent.post(`/messages/${b.id}`).type('form').send({ body: 'private' }).expect(302);
  const dm = db.prepare('SELECT id FROM messages WHERE sender_id = ? AND recipient_id = ?').get(a.id, b.id);

  const { io } = fakeIo();
  expect(broadcastGroupMessage(io, dm.id)).toBe(0);
  expect(io.to).not.toHaveBeenCalled();
  expect(broadcastGroupMessage(undefined, dm.id)).toBe(0);

  const groupId = await makeGroup(a, [b]);
  await post(a, groupId, 'saved before the push fails');
  const groupMessage = db.prepare('SELECT id FROM messages WHERE group_id = ?').get(groupId);
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  const failing = { to: () => { throw new Error('socket down'); } };
  expect(broadcastGroupMessage(failing, groupMessage.id)).toBe(0);
  errorSpy.mockRestore();
});

test('the group chat page listens for live messages and polls only as a safety net', async () => {
  const a = await makeUser('alice');
  const b = await makeUser('bob');
  const groupId = await makeGroup(a, [b]);

  const page = (await a.agent.get(`/groups/${groupId}`).expect(200)).text;
  expect(page).toContain('group:new');
  expect(page).toContain('setInterval(poll, 30000)');
  expect(page).not.toContain('setInterval(poll, 3000)');
});
