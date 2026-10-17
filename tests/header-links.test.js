const request = require('supertest');
const db = require('../src/db');
const app = require('../src/app');
const posts = require('../src/services/postService');
const engagement = require('../src/services/engagementService');

let counter = 0;
async function register() {
  counter += 1;
  const username = `hl_${counter}_u`;
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

test('logged-in pages link to every account feature', async () => {
  const a = await register();
  const page = (await a.agent.get('/users').expect(200)).text;

  [
    'href="/search"',
    'href="/notifications"',
    'data-notification-badge',
    'href="/bookmarks"',
    'href="/mentions"',
    'href="/account/security"',
    'href="/account/verify-email"',
    'href="/account/phone"',
    'href="/safety"',
    'href="/account/export"',
    'href="/account/delete"',
  ].forEach((link) => expect(page).toContain(link));
});

test('every linked page actually opens', async () => {
  const a = await register();
  for (const path of ['/search', '/notifications', '/bookmarks', '/mentions', '/account/security', '/account/verify-email', '/account/phone', '/safety', '/account/export']) {
    const res = await a.agent.get(path);
    expect([path, res.status]).toEqual([path, 200]);
  }
});

test('logged-out pages do not show the account menu', async () => {
  const page = (await request(app).get('/login').expect(200)).text;
  expect(page).not.toContain('href="/notifications"');
  expect(page).not.toContain('href="/account/phone"');
  expect(page).not.toContain('data-notification-badge');
});

test('the unread notification count appears next to the Notifications link', async () => {
  const a = await register();
  const b = await register();
  const post = posts.createPost(a.id, 'a post that gets a like');
  engagement.toggleLike(b.id, post);

  const withCount = (await a.agent.get('/users').expect(200)).text;
  expect(withCount).toMatch(/data-notification-badge>\(1\)<\/span>/);

  const without = (await b.agent.get('/users').expect(200)).text;
  expect(without).toMatch(/data-notification-badge><\/span>/);
});

test('the live notification script loads for logged-in people only', async () => {
  const a = await register();
  expect((await a.agent.get('/users').expect(200)).text).toContain('/js/notifications.js');
  expect((await request(app).get('/login').expect(200)).text).not.toContain('/js/notifications.js');
});
