const db = require('../src/db');
const posts = require('../src/services/postService');
const safety = require('../src/services/safetyService');
const moderation = require('../src/services/moderationService');

let counter = 0;
function makeUser(name, { admin = false } = {}) {
  counter += 1;
  const username = `${name}_${counter}_ml`;
  const id = Number(
    db
      .prepare('INSERT INTO users (username, email, password_hash, display_name, is_admin) VALUES (?, ?, ?, ?, ?)')
      .run(username, `${username}@example.com`, 'x', name, admin ? 1 : 0).lastInsertRowid
  );
  return { id, username };
}

function reported(reason = 'spam') {
  const author = makeUser('author');
  const reporter = makeUser('reporter');
  const postId = posts.createPost(author.id, `ml reported post ${counter}`);
  safety.report(reporter.id, postId, reason, '');
  const id = db.prepare('SELECT id FROM reports WHERE reporter_id = ? AND post_id = ?').get(reporter.id, postId).id;
  return { author, reporter, postId, id };
}

const statusOf = (id) => db.prepare('SELECT status FROM reports WHERE id = ?').get(id).status;
const logged = () => db.prepare('SELECT COUNT(*) AS n FROM admin_actions').get().n;
const entriesFor = (username) => moderation.recentActions().filter((a) => a.target_username === username);
const postExists = (id) => !!db.prepare('SELECT 1 FROM posts WHERE id = ?').get(id);
const errorOf = (fn) => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
};

describe('deciding a report', () => {
  test('resolving closes the report, keeps the post and logs who did it and why', () => {
    const admin = makeUser('admin', { admin: true });
    const r = reported('harassment');

    expect(moderation.handleReport(admin.id, r.id, 'resolve')).toEqual({ reportId: r.id, decision: 'resolve', postRemoved: false });

    expect(statusOf(r.id)).toBe('resolved');
    expect(postExists(r.postId)).toBe(true);
    expect(entriesFor(r.author.username)).toEqual([
      expect.objectContaining({
        action: 'report_resolve',
        target_user_id: r.author.id,
        admin_username: admin.username,
        note: `Report #${r.id} (harassment)`,
      }),
    ]);
  });

  test('dismissing closes the report, keeps the post and logs it', () => {
    const admin = makeUser('admin', { admin: true });
    const r = reported('other');

    expect(moderation.handleReport(admin.id, r.id, 'dismiss')).toMatchObject({ decision: 'dismiss', postRemoved: false });

    expect(statusOf(r.id)).toBe('dismissed');
    expect(postExists(r.postId)).toBe(true);
    expect(entriesFor(r.author.username)[0]).toMatchObject({ action: 'report_dismiss', note: `Report #${r.id} (other)` });
  });

  test('removing deletes the post, closes every report about it and writes one entry that says so', () => {
    const admin = makeUser('admin', { admin: true });
    const r = reported('abuse');
    const second = makeUser('second');
    safety.report(second.id, r.postId, 'spam', '');
    const secondId = db.prepare('SELECT id FROM reports WHERE reporter_id = ?').get(second.id).id;

    expect(moderation.handleReport(admin.id, r.id, 'remove')).toEqual({ reportId: r.id, decision: 'remove', postRemoved: true });

    expect(postExists(r.postId)).toBe(false);
    expect(statusOf(r.id)).toBe('resolved');
    expect(statusOf(secondId)).toBe('resolved');
    const entries = entriesFor(r.author.username);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'post_remove', note: `Report #${r.id} (abuse) and 1 more on the same post` });
  });

  test('a single report on a removed post is described without the "more" part', () => {
    const admin = makeUser('admin', { admin: true });
    const r = reported('spam');
    moderation.handleReport(admin.id, r.id, 'remove');
    expect(entriesFor(r.author.username)[0].note).toBe(`Report #${r.id} (spam)`);
  });

  test('the reporter is never written to the log', () => {
    const admin = makeUser('admin', { admin: true });
    const r = reported('spam');
    moderation.handleReport(admin.id, r.id, 'resolve');

    const text = JSON.stringify(entriesFor(r.author.username));
    expect(text).not.toContain(r.reporter.username);
    expect(text).not.toContain(`"id":${r.reporter.id}`);
  });
});

describe('refusals change nothing and log nothing', () => {
  test('non-admins, unknown or malformed reports, unknown decisions and repeats', () => {
    const admin = makeUser('admin', { admin: true });
    const plain = makeUser('plain');
    const r = reported('spam');
    const handled = reported('spam');
    moderation.handleReport(admin.id, handled.id, 'dismiss');

    const before = logged();
    const cases = [
      [() => moderation.handleReport(plain.id, r.id, 'resolve'), /Admins only/],
      [() => moderation.handleReport(999999, r.id, 'resolve'), /Admins only/],
      [() => moderation.handleReport(admin.id, 999999, 'resolve'), /not found or already handled/],
      [() => moderation.handleReport(admin.id, handled.id, 'resolve'), /not found or already handled/],
      [() => moderation.handleReport(admin.id, handled.id, 'remove'), /not found or already handled/],
      [() => moderation.handleReport(admin.id, String(r.id), 'resolve'), /not found or already handled/],
      [() => moderation.handleReport(admin.id, NaN, 'resolve'), /not found or already handled/],
      [() => moderation.handleReport(admin.id, 1.5, 'resolve'), /not found or already handled/],
      [() => moderation.handleReport(admin.id, null, 'resolve'), /not found or already handled/],
      [() => moderation.handleReport(admin.id, undefined, 'resolve'), /not found or already handled/],
      ...['delete', '', undefined, null, '__proto__', 'constructor', 'toString', 'RESOLVE'].map((decision) => [
        () => moderation.handleReport(admin.id, r.id, decision),
        /Unknown decision/,
      ]),
    ];

    cases.forEach(([run, message]) => {
      const error = errorOf(run);
      expect(error).toBeInstanceOf(moderation.ModerationError);
      expect(error.message).toMatch(message);
    });

    expect(logged()).toBe(before);
    expect(statusOf(r.id)).toBe('open');
    expect(postExists(r.postId)).toBe(true);
  });

  test('a report whose post is already gone cannot be "removed", but can still be resolved', () => {
    const admin = makeUser('admin', { admin: true });
    const r = reported('spam');
    db.prepare('DELETE FROM posts WHERE id = ?').run(r.postId);
    const before = logged();

    const error = errorOf(() => moderation.handleReport(admin.id, r.id, 'remove'));
    expect(error).toBeInstanceOf(moderation.ModerationError);
    expect(error.message).toMatch(/already deleted/);
    expect(logged()).toBe(before);
    expect(statusOf(r.id)).toBe('open');

    moderation.handleReport(admin.id, r.id, 'resolve');
    expect(statusOf(r.id)).toBe('resolved');
    expect(entriesFor(r.author.username)[0]).toMatchObject({ action: 'report_resolve' });
  });

  test('a repeat decision on the same report is refused and logs nothing more', () => {
    const admin = makeUser('admin', { admin: true });
    const r = reported('spam');
    moderation.handleReport(admin.id, r.id, 'resolve');
    const before = logged();

    expect(errorOf(() => moderation.handleReport(admin.id, r.id, 'resolve'))).toBeInstanceOf(moderation.ModerationError);
    expect(errorOf(() => moderation.handleReport(admin.id, r.id, 'dismiss'))).toBeInstanceOf(moderation.ModerationError);
    expect(logged()).toBe(before);
  });
});

describe('accounts that no longer exist', () => {
  test('a report about an author who has since left is logged as "a deleted account"', () => {
    const admin = makeUser('admin', { admin: true });
    const r = reported('abuse');
    db.prepare('DELETE FROM users WHERE id = ?').run(r.author.id);

    moderation.handleReport(admin.id, r.id, 'resolve');

    const entry = moderation.recentActions().find((a) => a.note === `Report #${r.id} (abuse)`);
    expect(entry).toMatchObject({ action: 'report_resolve', target_user_id: null, target_username: moderation.DELETED_ACCOUNT });
  });

  test('entries keep their text when the author or the admin is deleted later', () => {
    const admin = makeUser('admin', { admin: true });
    const r = reported('spam');
    moderation.handleReport(admin.id, r.id, 'dismiss');

    db.prepare('DELETE FROM users WHERE id = ?').run(r.author.id);
    let entry = moderation.recentActions().find((a) => a.note === `Report #${r.id} (spam)`);
    expect(entry).toMatchObject({ target_user_id: null, target_username: r.author.username, admin_username: admin.username });

    db.prepare('DELETE FROM users WHERE id = ?').run(admin.id);
    entry = moderation.recentActions().find((a) => a.note === `Report #${r.id} (spam)`);
    expect(entry).toMatchObject({ admin_username: null, target_username: r.author.username });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
