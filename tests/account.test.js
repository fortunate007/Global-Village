const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const db = require('../src/db');
const app = require('../src/app');
const posts = require('../src/services/postService');
const engagement = require('../src/services/engagementService');
const safety = require('../src/services/safetyService');
const accounts = require('../src/services/accountService');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const png = { filename: 'pic.png', contentType: 'image/png' };

let counter = 0;
async function makeUser(name) {
  counter += 1;
  const username = `${name}_${counter}_acct`;
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

const exists = (id) => !!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id);
const onDisk = (url) => fs.existsSync(path.join(__dirname, '..', 'src', 'public', url));
const destroy = (user, body = { password: 'secret123', confirm: 'yes' }) =>
  user.agent.post('/account/delete').type('form').send(body);

async function withIo(io, run) {
  const original = app.get('io');
  app.set('io', io);
  try {
    return await run();
  } finally {
    app.set('io', original);
  }
}

describe('the deletion page and form', () => {
  test('you must be logged in to see the page, and it lists what will be lost', async () => {
    expect((await request(app).get('/account/delete').expect(302)).headers.location).toBe('/login');

    const a = await makeUser('alice');
    posts.createPost(a.id, 'one');
    const page = (await a.agent.get('/account/delete').expect(200)).text;
    expect(page).toContain('name="password"');
    expect(page).toContain('1 post(s)');
  });

  test('a wrong password or a missing confirmation deletes nothing', async () => {
    const a = await makeUser('alice');

    const wrong = await destroy(a, { password: 'wrong-password', confirm: 'yes' }).expect(302);
    expect(wrong.headers.location).toBe('/account/delete');
    const unconfirmed = await destroy(a, { password: 'secret123' }).expect(302);
    expect(unconfirmed.headers.location).toBe('/account/delete');
    const empty = await destroy(a, { confirm: 'yes' }).expect(302);
    expect(empty.headers.location).toBe('/account/delete');

    expect(exists(a.id)).toBe(true);
    await a.agent.get('/users').expect(200);
  });

  test('the right password deletes the account, ends the session and frees the username', async () => {
    const a = await makeUser('alice');
    const res = await destroy(a).expect(302);

    expect(res.headers.location).toBe('/login');
    expect(exists(a.id)).toBe(false);
    expect((await a.agent.get('/users').expect(302)).headers.location).toBe('/login');

    const again = await request
      .agent(app)
      .post('/register')
      .type('form')
      .send({
        username: a.username,
        email: `${a.username}@example.com`,
        password: 'secret123',
        confirmPassword: 'secret123',
        displayName: 'Back again',
      })
      .expect(302);
    expect(again.headers.location).toBe('/users');
  });

  test('avatar and chat picture files are deleted from disk', async () => {
    const a = await makeUser('alice');
    const b = await makeUser('bob');
    await a.agent.post('/profile').field('displayName', 'Alice').attach('avatar', PNG, png).expect(302);
    await a.agent.post(`/messages/${b.id}`).attach('image', PNG, png).expect(302);
    await b.agent.post(`/messages/${a.id}`).attach('image', PNG, png).expect(302);

    const avatar = db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(a.id).avatar_url;
    const pictures = db.prepare('SELECT image_url FROM messages WHERE image_url IS NOT NULL AND (sender_id = ? OR recipient_id = ?)').all(a.id, a.id).map((r) => r.image_url);
    expect(pictures).toHaveLength(2);
    [avatar, ...pictures].forEach((url) => expect(onDisk(url)).toBe(true));

    await destroy(a).expect(302);
    [avatar, ...pictures].forEach((url) => expect(onDisk(url)).toBe(false));
  });

  test('open chat connections are closed', async () => {
    const a = await makeUser('alice');
    const disconnectSockets = jest.fn();
    const io = { in: jest.fn(() => ({ disconnectSockets })) };

    await withIo(io, () => destroy(a).expect(302));

    expect(io.in).toHaveBeenCalledWith(`user:${a.id}`);
    expect(disconnectSockets).toHaveBeenCalledWith(true);
  });

  test('the only admin cannot delete themselves, but can once another admin exists', async () => {
    const a = await makeUser('alice');
    const b = await makeUser('bob');
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(a.id);

    const refused = await destroy(a).expect(302);
    expect(refused.headers.location).toBe('/account/delete');
    expect(exists(a.id)).toBe(true);

    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(b.id);
    await destroy(a).expect(302);
    expect(exists(a.id)).toBe(false);
  });
});

describe('what the removal touches', () => {
  const hex = () => crypto.randomBytes(16).toString('hex');
  const url = (folder) => `/uploads/${folder}/${hex()}.png`;

  function makeRawUser(name, avatarUrl) {
    counter += 1;
    const username = `${name}_${counter}_raw`;
    const id = Number(
      db
        .prepare('INSERT INTO users (username, email, password_hash, display_name, avatar_url) VALUES (?, ?, ?, ?, ?)')
        .run(username, `${username}@example.com`, 'x', name, avatarUrl || '/img/default-avatar.svg').lastInsertRowid
    );
    return { id, username };
  }

  test('removes every trace, keeps other people\'s data and hands groups on', () => {
    const avatar = url('avatars');
    const a = makeRawUser('alice', avatar);
    const b = makeRawUser('bob');
    const c = makeRawUser('carol');
    const d = makeRawUser('dave');

    // posts, replies, likes, bookmarks, mentions, tags
    const postA = posts.createPost(a.id, `hello @${b.username} #goodbye`);
    posts.reply(b.id, postA, 'a reply');
    const postB = posts.createPost(b.id, `thanks @${a.username}`);
    engagement.toggleLike(b.id, postA);
    engagement.toggleLike(a.id, postB);
    engagement.toggleBookmark(a.id, postB);

    // friends, requests, blocks, mutes
    const addFriend = db.prepare('INSERT INTO friends (user_id, friend_id) VALUES (?, ?)');
    addFriend.run(a.id, b.id);
    addFriend.run(b.id, a.id);
    db.prepare('INSERT INTO friend_requests (sender_id, recipient_id) VALUES (?, ?)').run(c.id, a.id);
    safety.block(a.id, d.id);
    safety.mute(a.id, c.id);

    // direct messages with pictures: a to b, b to a, and b to c (unrelated to a)
    const dm = db.prepare('INSERT INTO messages (sender_id, recipient_id, body, image_url) VALUES (?, ?, ?, ?)');
    const urlAB = url('chat');
    const urlBA = url('chat');
    const urlBC = url('chat');
    dm.run(a.id, b.id, '', urlAB);
    dm.run(b.id, a.id, '', urlBA);
    dm.run(b.id, c.id, '', urlBC);

    // group 1: created by a, with b. group 2: only a, plus a leftover message from b who left.
    // group 3: created by b, with a.
    const makeGroup = (creator, members) => {
      const id = Number(db.prepare('INSERT INTO groups (name, created_by) VALUES (?, ?)').run('G', creator).lastInsertRowid);
      members.forEach((m) => db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(id, m));
      return id;
    };
    const gm = db.prepare('INSERT INTO messages (sender_id, group_id, body, image_url) VALUES (?, ?, ?, ?)');
    const g1 = makeGroup(a.id, [a.id, b.id]);
    const g2 = makeGroup(a.id, [a.id]);
    const g3 = makeGroup(b.id, [b.id, a.id]);
    const urlG1A = url('chat');
    const urlG1B = url('chat');
    const urlG2A = url('chat');
    const urlG2B = url('chat');
    const urlG3A = url('chat');
    gm.run(a.id, g1, '', urlG1A);
    gm.run(b.id, g1, '', urlG1B);
    gm.run(a.id, g2, '', urlG2A);
    gm.run(b.id, g2, '', urlG2B);
    gm.run(a.id, g3, '', urlG3A);

    const result = accounts.deleteAccount(a.id);

    // files to remove: everything tied to the account or to groups that disappeared
    expect(result.avatars).toContain(avatar);
    [urlAB, urlBA, urlG1A, urlG2A, urlG2B, urlG3A].forEach((u) => expect(result.chat).toContain(u));
    [urlBC, urlG1B].forEach((u) => expect(result.chat).not.toContain(u));

    // nothing in the database refers to the account any more
    [
      ['posts', 'author_id'], ['messages', 'sender_id'], ['messages', 'recipient_id'],
      ['group_members', 'user_id'], ['groups', 'created_by'], ['friends', 'user_id'], ['friends', 'friend_id'],
      ['friend_requests', 'sender_id'], ['friend_requests', 'recipient_id'], ['likes', 'user_id'],
      ['bookmarks', 'user_id'], ['blocks', 'blocker_id'], ['blocks', 'blocked_id'], ['mutes', 'muter_id'],
      ['mutes', 'muted_id'], ['mentions', 'user_id'], ['notifications', 'user_id'],
      ['notifications', 'actor_id'], ['reports', 'reporter_id'],
    ].forEach(([table, column]) => {
      expect({ table, column, rows: db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(a.id).n })
        .toEqual({ table, column, rows: 0 });
    });
    expect(exists(a.id)).toBe(false);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(() => db.prepare("INSERT INTO posts_fts(posts_fts) VALUES ('integrity-check')").run()).not.toThrow();

    // other people keep what is theirs
    expect(db.prepare('SELECT 1 FROM posts WHERE id = ?').get(postB)).toBeDefined();
    expect(db.prepare('SELECT 1 FROM posts WHERE id = ?').get(postA)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND recipient_id = ?').get(b.id, c.id).n).toBe(1);

    // groups: handed on to the remaining member, or deleted when nobody else was in them
    const group = (id) => db.prepare('SELECT created_by FROM groups WHERE id = ?').get(id);
    const members = (id) => db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(id).map((r) => r.user_id);
    expect(group(g1).created_by).toBe(b.id);
    expect(members(g1)).toEqual([b.id]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE group_id = ?').get(g1).n).toBe(1);
    expect(group(g2)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE group_id = ?').get(g2).n).toBe(0);
    expect(group(g3).created_by).toBe(b.id);
    expect(members(g3)).toEqual([b.id]);
  });

  test('a group the account created but already left is handed on, not deleted', () => {
    const a = makeRawUser('alice');
    const b = makeRawUser('bob');
    const gid = Number(db.prepare('INSERT INTO groups (name, created_by) VALUES (?, ?)').run('Left', a.id).lastInsertRowid);
    db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(gid, b.id);

    accounts.deleteAccount(a.id);
    expect(db.prepare('SELECT created_by FROM groups WHERE id = ?').get(gid).created_by).toBe(b.id);
  });

  test('a group the account was last in is deleted even if someone else created it', () => {
    const a = makeRawUser('alice');
    const b = makeRawUser('bob');
    const gid = Number(db.prepare('INSERT INTO groups (name, created_by) VALUES (?, ?)').run('Empty', b.id).lastInsertRowid);
    db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(gid, a.id);

    accounts.deleteAccount(a.id);
    expect(db.prepare('SELECT 1 FROM groups WHERE id = ?').get(gid)).toBeUndefined();
  });

  test('unknown accounts are refused', () => {
    expect(() => accounts.deleteAccount(999999)).toThrow(accounts.AccountError);
  });
});
