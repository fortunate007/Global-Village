const fs = require('fs');
const path = require('path');
const request = require('supertest');
const db = require('../src/db');
const app = require('../src/app');
const { removeAvatar } = require('../src/utils/avatarFiles');
const { removeChatImage } = require('../src/utils/chatFiles');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

let counter = 0;
async function makeUser(name) {
  counter += 1;
  const username = `${name}_${counter}_lc`;
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

const exists = (url) => fs.existsSync(path.join(__dirname, '..', 'src', 'public', url));
const png = { filename: 'pic.png', contentType: 'image/png' };

describe('profile pictures', () => {
  const avatarOf = (id) => db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(id).avatar_url;

  test('replacing your picture deletes the old file and keeps the new one', async () => {
    const a = await makeUser('alice');
    const upload = () =>
      a.agent.post('/profile').field('displayName', 'Alice').attach('avatar', PNG, png).expect(302);

    await upload();
    const first = avatarOf(a.id);
    expect(first).toMatch(/^\/uploads\/avatars\//);
    expect(exists(first)).toBe(true);

    await upload();
    const second = avatarOf(a.id);
    expect(second).not.toBe(first);
    expect(exists(first)).toBe(false);
    expect(exists(second)).toBe(true);
    expect(exists('/img/default-avatar.svg')).toBe(true);

    removeAvatar(second);
  });

  test('saving the profile without a new picture keeps the current file', async () => {
    const a = await makeUser('alice');
    await a.agent.post('/profile').field('displayName', 'Alice').attach('avatar', PNG, png).expect(302);
    const current = avatarOf(a.id);

    await a.agent.post('/profile').field('displayName', 'Alice Renamed').expect(302);

    expect(avatarOf(a.id)).toBe(current);
    expect(exists(current)).toBe(true);
    removeAvatar(current);
  });
});

describe('group pictures', () => {
  const newestGroup = (creatorId) =>
    db.prepare('SELECT id FROM groups WHERE created_by = ? ORDER BY id DESC').get(creatorId).id;

  test('pictures are removed only when the last member leaves and the group disappears', async () => {
    const a = await makeUser('alice');
    const b = await makeUser('bob');
    await a.agent.post('/groups').type('form').send({ name: 'Pics', memberIds: String(b.id) }).expect(302);
    const groupId = newestGroup(a.id);

    await a.agent.post(`/groups/${groupId}`).attach('image', PNG, png).expect(302);
    const { image_url: imageUrl } = db.prepare('SELECT image_url FROM messages WHERE group_id = ?').get(groupId);
    expect(exists(imageUrl)).toBe(true);

    await b.agent.post(`/groups/${groupId}/leave`).expect(302);
    expect(db.prepare('SELECT 1 FROM groups WHERE id = ?').get(groupId)).toBeDefined();
    expect(exists(imageUrl)).toBe(true);

    await a.agent.post(`/groups/${groupId}/leave`).expect(302);
    expect(db.prepare('SELECT 1 FROM groups WHERE id = ?').get(groupId)).toBeUndefined();
    expect(exists(imageUrl)).toBe(false);
    removeChatImage(imageUrl);
  });
});
