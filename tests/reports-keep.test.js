const path = require('path');
const { spawnSync } = require('child_process');
const db = require('../src/db');
const posts = require('../src/services/postService');
const safety = require('../src/services/safetyService');
const accounts = require('../src/services/accountService');

let counter = 0;
const makeUser = (name) => {
  counter += 1;
  const username = `${name}_${counter}_rk`;
  const id = Number(
    db
      .prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
      .run(username, `${username}@example.com`, 'x', name).lastInsertRowid
  );
  return { id, username };
};

const reportOf = (reporterId, postId) =>
  db.prepare('SELECT * FROM reports WHERE reporter_id = ? AND post_id = ?').get(reporterId, postId);
const openWithBody = (body) => safety.openReports().filter((r) => r.post_body === body);

test('the reporter column allows "no reporter"', () => {
  const column = db.prepare('PRAGMA table_info(reports)').all().find((c) => c.name === 'reporter_id');
  expect(column.notnull).toBe(0);
});

test('deleting the reporter keeps the report, its reason, details and the snapshot, without their name', () => {
  const author = makeUser('author');
  const reporter = makeUser('reporter');
  const postId = posts.createPost(author.id, 'rk keep this evidence');
  safety.report(reporter.id, postId, 'harassment', 'repeated messages');
  const id = reportOf(reporter.id, postId).id;

  accounts.deleteAccount(reporter.id);

  expect(db.prepare('SELECT reporter_id FROM reports WHERE id = ?').get(id).reporter_id).toBeNull();
  const [report] = openWithBody('rk keep this evidence');
  expect(report).toMatchObject({
    id,
    reason: 'harassment',
    details: 'repeated messages',
    post_id: postId,
    reporter_username: null,
    author_username: author.username,
  });
});

test('another person can still report the same post once the first reporter has left', () => {
  const author = makeUser('author');
  const first = makeUser('first');
  const second = makeUser('second');
  const postId = posts.createPost(author.id, 'rk reported twice');

  safety.report(first.id, postId, 'spam', '');
  accounts.deleteAccount(first.id);

  expect(safety.report(second.id, postId, 'spam', '')).toEqual({ created: true });
  expect(safety.report(second.id, postId, 'spam', '')).toEqual({ created: false });
  expect(openWithBody('rk reported twice')).toHaveLength(2);
});

test('when the reported author deletes their account the report stays with its snapshot', () => {
  const author = makeUser('author');
  const reporter = makeUser('reporter');
  const postId = posts.createPost(author.id, 'rk author goes away');
  safety.report(reporter.id, postId, 'abuse', '');

  accounts.deleteAccount(author.id);

  const [report] = openWithBody('rk author goes away');
  expect(report).toMatchObject({ post_id: null, author_username: null, reporter_username: reporter.username });
});

test('admins can still resolve a report whose reporter has left', () => {
  const author = makeUser('author');
  const reporter = makeUser('reporter');
  const admin = makeUser('admin');
  const postId = posts.createPost(author.id, 'rk resolve me');
  safety.report(reporter.id, postId, 'other', '');
  accounts.deleteAccount(reporter.id);

  const [report] = openWithBody('rk resolve me');
  safety.resolveReport(admin.id, report.id, 'resolved');
  expect(openWithBody('rk resolve me')).toEqual([]);
});

describe('pruning', () => {
  function resolvedReport(body, status, daysAgo) {
    const author = makeUser('author');
    const reporter = makeUser('reporter');
    const postId = posts.createPost(author.id, body);
    safety.report(reporter.id, postId, 'spam', '');
    const id = reportOf(reporter.id, postId).id;
    if (status !== 'open') {
      db.prepare(`UPDATE reports SET status = ?, resolved_at = datetime('now', ?) WHERE id = ?`).run(
        status,
        `-${daysAgo} days`,
        id
      );
    }
    return id;
  }
  const exists = (id) => !!db.prepare('SELECT 1 FROM reports WHERE id = ?').get(id);

  test('only old resolved and dismissed reports are removed, and only once', () => {
    const open = resolvedReport('rk prune open', 'open');
    const recent = resolvedReport('rk prune recent', 'resolved', 5);
    const oldResolved = resolvedReport('rk prune old resolved', 'resolved', 100);
    const oldDismissed = resolvedReport('rk prune old dismissed', 'dismissed', 200);

    expect(safety.countPrunable(90)).toBe(2);
    expect(safety.countPrunable(300)).toBe(0);

    expect(safety.pruneResolved(90)).toBe(2);
    expect(exists(open)).toBe(true);
    expect(exists(recent)).toBe(true);
    expect(exists(oldResolved)).toBe(false);
    expect(exists(oldDismissed)).toBe(false);
    expect(safety.pruneResolved(90)).toBe(0);
  });

  test('the age limit must be a whole number of days, 1 or more', () => {
    [0, -1, 1.5, NaN, 'x', undefined].forEach((days) => {
      expect(() => safety.pruneResolved(days)).toThrow(safety.SafetyError);
      expect(() => safety.countPrunable(days)).toThrow(safety.SafetyError);
    });
  });

  test('the command-line tool rejects a bad age and runs as a dry run by default', () => {
    const run = (...args) =>
      spawnSync(process.execPath, ['scripts/prune-reports.js', ...args], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, NODE_ENV: 'test' },
        encoding: 'utf8',
      });

    const bad = run('--days=abc');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/--days must be/);

    const dry = run('--days=30');
    expect(dry.status).toBe(0);
    expect(dry.stdout).toMatch(/No resolved or dismissed reports/);
  });
});

describe('admin page', () => {
  test('shows "a deleted account" for a report whose reporter has left', async () => {
    const request = require('supertest');
    const app = require('../src/app');
    const admin = request.agent(app);
    await admin
      .post('/register')
      .type('form')
      .send({
        username: 'rk_page_admin',
        email: 'rk_page_admin@example.com',
        password: 'secret123',
        confirmPassword: 'secret123',
        displayName: 'Admin',
      })
      .expect(302);
    db.prepare("UPDATE users SET is_admin = 1 WHERE username = 'rk_page_admin'").run();

    const author = makeUser('author');
    const reporter = makeUser('reporter');
    const postId = posts.createPost(author.id, 'rk shown on the admin page');
    safety.report(reporter.id, postId, 'spam', '');
    accounts.deleteAccount(reporter.id);

    const page = (await admin.get('/admin/reports').expect(200)).text;
    expect(page).toContain('rk shown on the admin page');
    expect(page).toContain('reported by a deleted account');
  });
});

describe('deletion page', () => {
  test('tells people their reports stay with the moderators', async () => {
    const request = require('supertest');
    const app = require('../src/app');
    const agent = request.agent(app);
    await agent
      .post('/register')
      .type('form')
      .send({
        username: 'rk_page_user',
        email: 'rk_page_user@example.com',
        password: 'secret123',
        confirmPassword: 'secret123',
        displayName: 'Reader',
      })
      .expect(302);

    const page = (await agent.get('/account/delete').expect(200)).text;
    expect(page).toContain('stay with the moderators');
    expect(page).not.toContain('Reports you filed are removed');
  });
});
