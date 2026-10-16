const db = require('../src/db');
const moderation = require('../src/services/moderationService');

let counter = 0;
function makeUser(name, { admin = false } = {}) {
  counter += 1;
  const username = `${name}_${counter}_mod`;
  const id = Number(
    db
      .prepare('INSERT INTO users (username, email, password_hash, display_name, is_admin) VALUES (?, ?, ?, ?, ?)')
      .run(username, `${username}@example.com`, 'HASH-X', name, admin ? 1 : 0).lastInsertRowid
  );
  return { id, username };
}

const row = (id) =>
  db.prepare('SELECT suspended_at, suspended_reason, session_epoch FROM users WHERE id = ?').get(id);
const auditCount = () => db.prepare('SELECT COUNT(*) AS n FROM admin_actions').get().n;
const errorOf = (fn) => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
};

describe('suspending', () => {
  test('marks the account, ends its sessions and writes the log', () => {
    const admin = makeUser('admin', { admin: true });
    const target = makeUser('target');
    const before = row(target.id);

    expect(moderation.suspend(admin.id, target.id, '  repeated abuse  ')).toEqual({ id: target.id, username: target.username });

    const after = row(target.id);
    expect(after.suspended_at).toBeTruthy();
    expect(after.suspended_reason).toBe('repeated abuse');
    expect(after.session_epoch).toBe(before.session_epoch + 1);

    const [entry] = moderation.recentActions().filter((a) => a.target_user_id === target.id);
    expect(entry).toMatchObject({
      action: 'suspend',
      note: 'repeated abuse',
      target_username: target.username,
      admin_username: admin.username,
    });
  });

  test('an empty reason is allowed, and a long one is cut at 500 characters', () => {
    const admin = makeUser('admin', { admin: true });
    const plain = makeUser('plain');
    const wordy = makeUser('wordy');

    moderation.suspend(admin.id, plain.id, '   ');
    expect(row(plain.id).suspended_reason).toBeNull();

    moderation.suspend(admin.id, wordy.id, 'x'.repeat(900));
    expect(row(wordy.id).suspended_reason).toHaveLength(500);

    const target = makeUser('typed');
    moderation.suspend(admin.id, target.id, ['not', 'text']);
    expect(row(target.id).suspended_reason).toBeNull();
  });

  test('refusals change nothing and write nothing', () => {
    const admin = makeUser('admin', { admin: true });
    const otherAdmin = makeUser('admin2', { admin: true });
    const plainUser = makeUser('plain');
    const target = makeUser('target');
    const already = makeUser('already');
    moderation.suspend(admin.id, already.id, 'first time');

    const cases = [
      [() => moderation.suspend(plainUser.id, target.id, ''), /Admins only/, target.id],
      [() => moderation.suspend(999999, target.id, ''), /Admins only/, target.id],
      [() => moderation.suspend(admin.id, 999999, ''), /not found/, null],
      [() => moderation.suspend(admin.id, '5', ''), /not found/, null],
      [() => moderation.suspend(admin.id, NaN, ''), /not found/, null],
      [() => moderation.suspend(admin.id, 1.5, ''), /not found/, null],
      [() => moderation.suspend(admin.id, null, ''), /not found/, null],
      [() => moderation.suspend(admin.id, undefined, ''), /not found/, null],
      [() => moderation.suspend(admin.id, admin.id, ''), /your own account/, admin.id],
      [() => moderation.suspend(admin.id, otherAdmin.id, ''), /Admins cannot be suspended/, otherAdmin.id],
      [() => moderation.suspend(admin.id, already.id, ''), /already suspended/, already.id],
    ];

    const logged = auditCount();
    const states = new Map([target.id, admin.id, otherAdmin.id, already.id].map((id) => [id, row(id)]));
    cases.forEach(([run, message]) => {
      const error = errorOf(run);
      expect(error).toBeInstanceOf(moderation.ModerationError);
      expect(error.message).toMatch(message);
    });

    expect(auditCount()).toBe(logged);
    states.forEach((state, id) => expect(row(id)).toEqual(state));
  });
});

describe('unsuspending', () => {
  test('clears the suspension and writes the log, but does not bring old sessions back', () => {
    const admin = makeUser('admin', { admin: true });
    const target = makeUser('target');
    moderation.suspend(admin.id, target.id, 'cooling off');
    const suspended = row(target.id);

    expect(moderation.unsuspend(admin.id, target.id, 'apologised')).toEqual({ id: target.id, username: target.username });

    expect(row(target.id)).toEqual({ suspended_at: null, suspended_reason: null, session_epoch: suspended.session_epoch });
    const [latest] = moderation.recentActions().filter((a) => a.target_user_id === target.id);
    expect(latest).toMatchObject({ action: 'unsuspend', note: 'apologised' });
  });

  test('is refused for accounts that are not suspended, unknown accounts and non-admins', () => {
    const admin = makeUser('admin', { admin: true });
    const plainUser = makeUser('plain');
    const target = makeUser('target');
    const suspended = makeUser('suspended');
    moderation.suspend(admin.id, suspended.id, '');

    const logged = auditCount();
    expect(errorOf(() => moderation.unsuspend(admin.id, target.id, ''))).toMatchObject({ message: expect.stringMatching(/not suspended/) });
    expect(errorOf(() => moderation.unsuspend(admin.id, 999999, ''))).toBeInstanceOf(moderation.ModerationError);
    expect(errorOf(() => moderation.unsuspend(plainUser.id, suspended.id, ''))).toMatchObject({ message: expect.stringMatching(/Admins only/) });
    expect(auditCount()).toBe(logged);
    expect(row(suspended.id).suspended_at).toBeTruthy();
  });
});

describe('lists and search', () => {
  test('search ignores letter case, treats % and _ literally and exposes no private columns', () => {
    db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
      .run('lk_abc', 'lk_abc@example.com', 'HASH-X', '100% Real');
    db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
      .run('lkxabc', 'lkxabc@example.com', 'HASH-X', 'Other Person');

    expect(moderation.searchUsers('LK_ABC').map((u) => u.username)).toEqual(['lk_abc']);
    expect(moderation.searchUsers('100%').map((u) => u.username)).toEqual(['lk_abc']);
    expect(moderation.searchUsers('%').map((u) => u.username)).toEqual(['lk_abc']);
    expect(moderation.searchUsers('other person').map((u) => u.username)).toEqual(['lkxabc']);

    const [found] = moderation.searchUsers('lkxabc');
    expect(Object.keys(found).sort()).toEqual(
      ['created_at', 'display_name', 'id', 'is_admin', 'suspended_at', 'suspended_reason', 'username']
    );
    expect(JSON.stringify(found)).not.toContain('HASH-X');
    expect(JSON.stringify(found)).not.toContain('@example.com');
  });

  test('search respects the limit, and empty or odd queries find nothing', () => {
    [1, 2, 3].forEach((n) => makeUser(`limitprobe${n}`));
    expect(moderation.searchUsers('limitprobe')).toHaveLength(3);
    expect(moderation.searchUsers('limitprobe', 2)).toHaveLength(2);

    ['', '   ', undefined, null, 42, ['limitprobe'], {}].forEach((query) => {
      expect(moderation.searchUsers(query)).toEqual([]);
    });
    expect(() => moderation.searchUsers('x'.repeat(5000))).not.toThrow();
  });

  test('the suspended list holds only suspended accounts, newest first', () => {
    const admin = makeUser('admin', { admin: true });
    const first = makeUser('first');
    const second = makeUser('second');
    const free = makeUser('free');
    moderation.suspend(admin.id, first.id, '');
    moderation.suspend(admin.id, second.id, '');
    db.prepare("UPDATE users SET suspended_at = datetime('now', '-2 days') WHERE id = ?").run(first.id);
    db.prepare("UPDATE users SET suspended_at = datetime('now', '-1 days') WHERE id = ?").run(second.id);

    const ids = moderation.listSuspended().map((u) => u.id);
    expect(ids).not.toContain(free.id);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
    expect(ids.indexOf(second.id)).toBeGreaterThan(-1);
  });
});

describe('the moderation log', () => {
  test('lists newest first and survives the deletion of either account', () => {
    const admin = makeUser('admin', { admin: true });
    const target = makeUser('target');
    moderation.suspend(admin.id, target.id, 'one');
    moderation.unsuspend(admin.id, target.id, 'two');

    const actions = moderation.recentActions().filter((a) => a.target_username === target.username);
    expect(actions.map((a) => a.action)).toEqual(['unsuspend', 'suspend']);

    db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
    const afterTarget = moderation.recentActions().filter((a) => a.target_username === target.username);
    expect(afterTarget).toHaveLength(2);
    afterTarget.forEach((a) => expect(a.target_user_id).toBeNull());

    db.prepare('DELETE FROM users WHERE id = ?').run(admin.id);
    const afterAdmin = moderation.recentActions().filter((a) => a.target_username === target.username);
    afterAdmin.forEach((a) => expect(a.admin_username).toBeNull());
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('the limit applies', () => {
    expect(moderation.recentActions(1).length).toBeLessThanOrEqual(1);
  });
});
