const request = require('supertest');
const db = require('../src/db');
const app = require('../src/app');
const posts = require('../src/services/postService');
const safety = require('../src/services/safetyService');

let counter = 0;
async function makeAccount(name, { admin = false } = {}) {
  counter += 1;
  const username = `${name}_${counter}_mlr`;
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
  if (admin) db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(id);
  return { id, username, agent };
}

function makeRaw(name) {
  counter += 1;
  const username = `${name}_${counter}_raw`;
  const id = Number(
    db
      .prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
      .run(username, `${username}@example.com`, 'x', name).lastInsertRowid
  );
  return { id, username };
}

function reported(reason = 'spam') {
  const author = makeRaw('author');
  const reporter = makeRaw('reporter');
  const body = `mlr-body-${counter}`;
  const postId = posts.createPost(author.id, body);
  safety.report(reporter.id, postId, reason, '');
  const id = db.prepare('SELECT id FROM reports WHERE reporter_id = ? AND post_id = ?').get(reporter.id, postId).id;
  return { author, reporter, postId, id, body };
}

const statusOf = (id) => db.prepare('SELECT status FROM reports WHERE id = ?').get(id).status;
const logged = () => db.prepare('SELECT COUNT(*) AS n FROM admin_actions').get().n;
const decide = (user, id, action) => user.agent.post(`/admin/reports/${id}/${action}`).type('form').send({});

test('each decision updates the report, is logged and shows on the log page with the right wording', async () => {
  const admin = await makeAccount('admin', { admin: true });
  const cases = [
    ['resolve', 'resolved a report about', 'resolved'],
    ['dismiss', 'dismissed a report about', 'dismissed'],
    ['remove', 'removed a post by', 'resolved'],
  ];

  for (const [action, wording, status] of cases) {
    const r = reported('harassment');
    const res = await decide(admin, r.id, action).expect(302);
    expect(res.headers.location).toBe('/admin/reports');

    expect(statusOf(r.id)).toBe(status);
    expect(!!db.prepare('SELECT 1 FROM posts WHERE id = ?').get(r.postId)).toBe(action !== 'remove');

    const log = (await admin.agent.get('/admin/actions').expect(200)).text;
    expect(log).toContain(wording);
    expect(log).toContain(`@${admin.username}`);
    expect(log).toContain(`@${r.author.username}`);
    expect(log).toContain(`Report #${r.id} (harassment)`);
    expect(log).not.toContain(r.reporter.username);
  }
});

test('a handled report leaves the open reports page', async () => {
  const admin = await makeAccount('admin', { admin: true });
  const r = reported('spam');

  expect((await admin.agent.get('/admin/reports').expect(200)).text).toContain(r.body);
  await decide(admin, r.id, 'dismiss').expect(302);
  expect((await admin.agent.get('/admin/reports').expect(200)).text).not.toContain(r.body);
});

test('non-admins and visitors cannot decide reports, and nothing is logged', async () => {
  const plain = await makeAccount('plain');
  const r = reported('spam');
  const before = logged();

  await decide(plain, r.id, 'resolve').expect(404);
  await decide(plain, r.id, 'remove').expect(404);
  await request(app).post(`/admin/reports/${r.id}/dismiss`).type('form').send({}).expect(404);

  expect(statusOf(r.id)).toBe('open');
  expect(logged()).toBe(before);
});

test('repeating a decision, or deciding a report that does not exist, is answered politely and logs nothing more', async () => {
  const admin = await makeAccount('admin', { admin: true });
  const r = reported('spam');
  await decide(admin, r.id, 'resolve').expect(302);
  const before = logged();

  expect((await decide(admin, r.id, 'resolve').expect(302)).headers.location).toBe('/admin/reports');
  expect((await decide(admin, r.id, 'remove').expect(302)).headers.location).toBe('/admin/reports');
  expect((await decide(admin, 999999, 'dismiss').expect(302)).headers.location).toBe('/admin/reports');
  await admin.agent.post('/admin/reports/abc/resolve').type('form').send({}).expect(404);
  await admin.agent.post(`/admin/reports/${r.id}/delete`).type('form').send({}).expect(404);

  expect(logged()).toBe(before);
});

test('removing a post whose report was already filed against a deleted post is refused, not a crash', async () => {
  const admin = await makeAccount('admin', { admin: true });
  const r = reported('spam');
  db.prepare('DELETE FROM posts WHERE id = ?').run(r.postId);
  const before = logged();

  expect((await decide(admin, r.id, 'remove').expect(302)).headers.location).toBe('/admin/reports');
  expect(statusOf(r.id)).toBe('open');
  expect(logged()).toBe(before);
});

test('an author who has left is shown as "a deleted account" on the log page', async () => {
  const admin = await makeAccount('admin', { admin: true });
  const r = reported('abuse');
  db.prepare('DELETE FROM users WHERE id = ?').run(r.author.id);

  await decide(admin, r.id, 'resolve').expect(302);

  const log = (await admin.agent.get('/admin/actions').expect(200)).text;
  expect(log).toContain('a deleted account');
  expect(log).toContain(`Report #${r.id} (abuse)`);
  expect(log).not.toContain('(deleted account)');
});

test('suspension entries still read the way they did, and everything on the page is escaped', async () => {
  const admin = await makeAccount('admin', { admin: true });
  const target = await makeAccount('target');
  const res = await admin.agent
    .post(`/admin/users/${target.id}/suspend`)
    .type('form')
    .send({ reason: '<script>alert(1)</script>' })
    .expect(302);
  expect(res.headers.location).toBe('/admin/users');

  const log = (await admin.agent.get('/admin/actions').expect(200)).text;
  expect(log).toContain('suspended');
  expect(log).toContain(`@${target.username}`);
  expect(log).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(log).not.toContain('<script>alert(1)</script>');
});
