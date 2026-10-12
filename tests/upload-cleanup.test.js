const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../src/db');
const { findOrphans, removeOrphans } = require('../src/utils/uploadCleanup');
const { removeAvatar, AVATAR_DIR } = require('../src/utils/avatarFiles');

let seq = 0;
const uniqueName = () => `${String((seq += 1)).padStart(32, '0')}.png`;
let userCounter = 0;
const makeUser = (avatarUrl) => {
  userCounter += 1;
  const name = `cleanup_${userCounter}_u`;
  return Number(
    db
      .prepare('INSERT INTO users (username, email, password_hash, display_name, avatar_url) VALUES (?, ?, ?, ?, ?)')
      .run(name, `${name}@example.com`, 'x', name, avatarUrl || '/img/default-avatar.svg').lastInsertRowid
  );
};

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-'));
  fs.mkdirSync(path.join(root, 'avatars'));
  fs.mkdirSync(path.join(root, 'chat'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function put(folder, fileName, ageHours = 48) {
  const file = path.join(root, folder, fileName);
  fs.writeFileSync(file, 'x');
  const when = new Date(Date.now() - ageHours * 3600 * 1000);
  fs.utimesSync(file, when, when);
  return file;
}

const names = (list) => list.map((o) => `${o.folder}/${o.name}`).sort();

test('lists old files nothing points to, and keeps files that are still used', () => {
  const usedAvatar = uniqueName();
  const unusedAvatar = uniqueName();
  const usedChat = uniqueName();
  const unusedChat = uniqueName();
  const owner = makeUser(`/uploads/avatars/${usedAvatar}`);
  const other = makeUser();
  db.prepare("INSERT INTO messages (sender_id, recipient_id, body, image_url) VALUES (?, ?, '', ?)")
    .run(owner, other, `/uploads/chat/${usedChat}`);
  [['avatars', usedAvatar], ['avatars', unusedAvatar], ['chat', usedChat], ['chat', unusedChat]].forEach(([f, n]) => put(f, n));

  expect(names(findOrphans(db, { root }))).toEqual([`avatars/${unusedAvatar}`, `chat/${unusedChat}`].sort());
});

test('group avatars count as used', () => {
  const groupAvatar = uniqueName();
  const creator = makeUser();
  db.prepare('INSERT INTO groups (name, avatar_url, created_by) VALUES (?, ?, ?)')
    .run('Pictured', `/uploads/avatars/${groupAvatar}`, creator);
  put('avatars', groupAvatar);

  expect(findOrphans(db, { root })).toEqual([]);
});

test('a deleted message no longer protects its old picture', () => {
  const gone = uniqueName();
  const a = makeUser();
  const b = makeUser();
  db.prepare("INSERT INTO messages (sender_id, recipient_id, body, image_url, deleted_at) VALUES (?, ?, '', NULL, CURRENT_TIMESTAMP)").run(a, b);
  put('chat', gone);

  expect(names(findOrphans(db, { root }))).toEqual([`chat/${gone}`]);
});

test('recent files are skipped by the grace period', () => {
  const fresh = uniqueName();
  const old = uniqueName();
  put('chat', fresh, 1);
  put('chat', old, 30);

  expect(names(findOrphans(db, { root }))).toEqual([`chat/${old}`]);
  expect(names(findOrphans(db, { root, minAgeHours: 0 }))).toEqual([`chat/${fresh}`, `chat/${old}`].sort());
});

test('files that are not named like uploads are never listed, and missing folders are fine', () => {
  put('avatars', '.gitkeep');
  put('avatars', 'notes.txt');
  put('avatars', 'photo.png');
  put('chat', 'ABCDEFABCDEFABCDEFABCDEFABCDEFAB.png');
  fs.mkdirSync(path.join(root, 'chat', 'abcdefabcdefabcdefabcdefabcdefab.png'));
  expect(findOrphans(db, { root })).toEqual([]);

  fs.rmSync(path.join(root, 'chat'), { recursive: true, force: true });
  expect(() => findOrphans(db, { root })).not.toThrow();
});

test('removing orphans deletes only the listed files and reports the totals', () => {
  const orphan = uniqueName();
  const keep = uniqueName();
  const owner = makeUser(`/uploads/avatars/${keep}`);
  expect(owner).toBeGreaterThan(0);
  const orphanFile = put('avatars', orphan);
  const keepFile = put('avatars', keep);

  const list = findOrphans(db, { root });
  expect(removeOrphans(list)).toEqual({ removed: 1, bytes: 1 });
  expect(fs.existsSync(orphanFile)).toBe(false);
  expect(fs.existsSync(keepFile)).toBe(true);
  expect(removeOrphans(list)).toEqual({ removed: 0, bytes: 0 });
});

test('removeAvatar deletes exactly one upload and ignores everything else', () => {
  const name = 'abcdefabcdefabcdefabcdefabcdefab.png';
  const file = path.join(AVATAR_DIR, name);
  fs.writeFileSync(file, 'x');

  expect(removeAvatar(`/uploads/avatars/${name}`)).toBe(true);
  expect(fs.existsSync(file)).toBe(false);
  expect(removeAvatar(`/uploads/avatars/${name}`)).toBe(false);
  expect(removeAvatar('/img/default-avatar.svg')).toBe(false);
  expect(removeAvatar('../../package.json')).toBe(false);
  expect(removeAvatar(null)).toBe(false);
  expect(fs.existsSync(path.join(__dirname, '..', 'package.json'))).toBe(true);
});
