const fs = require('fs');
const path = require('path');
const request = require('supertest');
const db = require('../src/db');
const app = require('../src/app');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

let counter = 0;
async function makeUser(name) {
  counter += 1;
  const username = `${name}_${counter}_gm`;
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
    .send({ name: 'Edits', memberIds: members.map((m) => String(m.id)) })
    .expect(302);
  return newestGroup(creator.id);
}

async function say(user, groupId, body) {
  await user.agent.post(`/groups/${groupId}`).type('form').send({ body }).expect(302);
  return db.prepare('SELECT id FROM messages WHERE group_id = ? AND sender_id = ? ORDER BY id DESC').get(groupId, user.id).id;
}

async function sayWithImage(user, groupId) {
  await user.agent
    .post(`/groups/${groupId}`)
    .attach('image', PNG, { filename: 'pic.png', contentType: 'image/png' })
    .expect(302);
  return db
    .prepare('SELECT id, image_url FROM messages WHERE group_id = ? AND sender_id = ? ORDER BY id DESC')
    .get(groupId, user.id);
}

const row = (id) => db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
const edit = (user, groupId, messageId, body) =>
  user.agent.post(`/groups/${groupId}/messages/${messageId}/edit`).type('form').send({ body }).expect(302);
const remove = (user, groupId, messageId) =>
  user.agent.post(`/groups/${groupId}/messages/${messageId}/delete`).expect(302);
const fileExists = (url) => fs.existsSync(path.join(__dirname, '..', 'src', 'public', url));

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

describe('editing', () => {
  test('the sender can edit, and every member is updated live', async () => {
    const a = await makeUser('alice');
    const b = await makeUser('bob');
    const c = await makeUser('carol');
    const groupId = await makeGroup(a, [b, c]);
    const messageId = await say(a, groupId, 'first version');
    const { io, emit, rooms } = fakeIo();

    await withIo(io, () => edit(a, groupId, messageId, '  second version  '));

    expect(row(messageId)).toMatchObject({ body: 'second version' });
    expect(row(messageId).edited_at).toBeTruthy();
    expect(rooms()).toEqual(roomsFor(a, b, c));
    expect(emit).toHaveBeenCalledWith('group:edited', { id: messageId, group_id: groupId, body: 'second version' });
  });

  test('people who blocked the sender, or were blocked by them, are not told', async () => {
    const a = await makeUser('alice');
    const b = await makeUser('bob');
    const c = await makeUser('carol');
    const groupId = await makeGroup(a, [b, c]);
    const messageId = await say(a, groupId, 'before');
    await c.agent.post(`/safety/block/${a.id}`).expect(302);
    const { io, rooms } = fakeIo();

    await withIo(io, () => edit(a, groupId, messageId, 'after'));
    expect(rooms()).toEqual(roomsFor(a, b));
  });

  test('only the sender, from inside the right group, can edit', async () => {
    const a = await makeUser('alice');
    const b = await makeUser('bob');
    const outsider = await makeUser('olive');
    const groupId = await makeGroup(a, [b]);
    const otherGroup = await makeGroup(a, [b]);
    const messageId = await say(a, groupId, 'mine');
    const { io } = fakeIo();

    await withIo(io, async () => {
      await edit(b, groupId, messageId, 'hijack');
      await edit(outsider, groupId, messageId, 'hijack');
      await edit(a, otherGroup, messageId, 'wrong group in the URL');
    });

    expect(row(messageId)).toMatchObject({ body: 'mine', edited_at: null });
    expect(io.to).not.toHaveBeenCalled();
  });

  test('empty text, text over the limit, unchanged text and image-only messages change nothing', async () => {
    const a = await makeUser('alice');
    const b = await makeUser('bob');
    const groupId = await makeGroup(a, [b]);
    const messageId = await say(a, groupId, 'steady');
    const image = await sayWithImage(a, groupId);
    const { io } = fakeIo();

    await withIo(io, async () => {
      await edit(a, groupId, messageId, '   ');
      await edit(a, groupId, messageId, 'x'.repeat(2001));
      await edit(a, groupId, messageId, 'steady');
      await edit(a, groupId, image.id, 'caption added');
    });

    expect(row(messageId)).toMatchObject({ body: 'steady', edited_at: null });
    expect(row(image.id).body).toBe('');
    expect(io.to).not.toHaveBeenCalled();
    await remove(a, groupId, image.id);
  });

  test('deleted messages cannot be edited, and people who left cannot edit', async () => {
    const a = await makeUser('alice');
    const b = await makeUser('bob');
    const groupId = await makeGroup(a, [b]);
    const gone = await say(a, groupId, 'soon deleted');
    const bobs = await say(b, groupId, 'bob wrote this');
    await remove(a, groupId, gone);
    await b.agent.post(`/groups/${groupId}/leave`).expect(302);

    await edit(a, groupId, gone, 'resurrected');
    await edit(b, groupId, bobs, 'edited after leaving');

    expect(row(gone).body).toBe('');
    expect(row(bobs).body).toBe('bob wrote this');
  });
});

describe('deleting', () => {
  test('the sender can delete, every member is updated live, and repeating it does nothing', async () => {
    const a = await makeUser('alice');
    const b = await makeUser('bob');
    const groupId = await makeGroup(a, [b]);
    const messageId = await say(a, groupId, 'regret');
    const { io, emit, rooms } = fakeIo();

    await withIo(io, () => remove(a, groupId, messageId));
    expect(row(messageId)).toMatchObject({ body: '', image_url: null });
    expect(row(messageId).deleted_at).toBeTruthy();
    expect(rooms()).toEqual(roomsFor(a, b));
    expect(emit).toHaveBeenCalledWith('group:deleted', { id: messageId, group_id: groupId });

    io.to.mockClear();
    await withIo(io, () => remove(a, groupId, messageId));
    expect(io.to).not.toHaveBeenCalled();
  });

  test('only the sender can delete, and the URL cannot reach another group', async () => {
    const a = await makeUser('alice');
    const b = await makeUser('bob');
    const outsider = await makeUser('olive');
    const groupId = await makeGroup(a, [b]);
    const otherGroup = await makeGroup(a, [b]);
    const messageId = await say(a, groupId, 'keep me');

    await remove(b, groupId, messageId);
    await remove(outsider, groupId, messageId);
    await remove(a, otherGroup, messageId);

    expect(row(messageId)).toMatchObject({ body: 'keep me', deleted_at: null });
  });

  test('after leaving, you can still delete your own old messages, and members hear about it', async () => {
    const a = await makeUser('alice');
    const b = await makeUser('bob');
    const c = await makeUser('carol');
    const groupId = await makeGroup(a, [b, c]);
    const messageId = await say(b, groupId, 'left behind');
    await b.agent.post(`/groups/${groupId}/leave`).expect(302);
    const { io, rooms } = fakeIo();

    await withIo(io, () => remove(b, groupId, messageId));

    expect(row(messageId).deleted_at).toBeTruthy();
    expect(rooms()).toEqual(roomsFor(a, c));
  });

  test('deleting a message with a picture also deletes the picture file', async () => {
    const a = await makeUser('alice');
    const b = await makeUser('bob');
    const groupId = await makeGroup(a, [b]);
    const image = await sayWithImage(a, groupId);

    expect(image.image_url).toMatch(/^\/uploads\/chat\//);
    expect(fileExists(image.image_url)).toBe(true);

    await remove(a, groupId, image.id);
    expect(fileExists(image.image_url)).toBe(false);
  });
});

describe('direct messages', () => {
  test('deleting a direct message with a picture also deletes the picture file', async () => {
    const a = await makeUser('alice');
    const b = await makeUser('bob');
    await a.agent
      .post(`/messages/${b.id}`)
      .attach('image', PNG, { filename: 'pic.png', contentType: 'image/png' })
      .expect(302);
    const message = db
      .prepare('SELECT id, image_url FROM messages WHERE sender_id = ? AND recipient_id = ? ORDER BY id DESC')
      .get(a.id, b.id);
    expect(fileExists(message.image_url)).toBe(true);

    await a.agent.post(`/messages/${b.id}/${message.id}/delete`).expect(302);
    expect(fileExists(message.image_url)).toBe(false);
  });
});

describe('chat page', () => {
  test('your own group messages get edit and delete controls, other people\'s do not', async () => {
    const a = await makeUser('alice');
    const b = await makeUser('bob');
    const groupId = await makeGroup(a, [b]);
    const mine = await say(a, groupId, 'from alice');
    const theirs = await say(b, groupId, 'from bob');

    const pageA = (await a.agent.get(`/groups/${groupId}`).expect(200)).text;
    expect(pageA).toContain(`/groups/${groupId}/messages/${mine}/delete`);
    expect(pageA).not.toContain(`/groups/${groupId}/messages/${theirs}/delete`);
    expect(pageA).toContain('group:edited');
    expect(pageA).toContain('group:deleted');
    expect(pageA).toContain('/groups/${targetId}/messages/${id}/edit');
  });
});
