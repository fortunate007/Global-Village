const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../src/db');
const posts = require('../src/services/postService');
const images = require('../src/services/postImageService');
const sweep = require('../src/services/uploadSweep');

let counter = 0;
function makeUser(name) {
  counter += 1;
  const username = `${name}_${counter}_pi`;
  const id = Number(
    db
      .prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
      .run(username, `${username}@example.com`, 'x', name).lastInsertRowid
  );
  return { id, username };
}

let fileCounter = 0;
const fakeName = (ext = 'png') => `${String((fileCounter += 1)).padStart(32, '0')}.${ext}`;
const image = (extra = {}) => ({ filename: fakeName(), mime: 'image/png', size: 100, alt: '', ...extra });
const errorOf = (fn) => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
};

test('the migration created the table and was recorded', () => {
  const columns = db.prepare("SELECT name FROM pragma_table_info('post_images')").all().map((c) => c.name);
  expect(columns).toEqual(['id', 'post_id', 'position', 'filename', 'mime', 'size', 'alt_text', 'created_at']);
  expect(db.prepare("SELECT 1 FROM schema_migrations WHERE name = '0002_post_images'").get()).toBeDefined();
});

describe('creating posts with pictures', () => {
  test('a post with text and pictures keeps their order and descriptions', () => {
    const a = makeUser('alice');
    const first = image({ alt: '  A red door  ' });
    const second = image({ alt: 'x'.repeat(500) });
    const id = images.createPostWithImages({ authorId: a.id, body: 'hello #pictures', images: [first, second] });

    const stored = images.imagesFor(id);
    expect(stored.map((i) => i.filename)).toEqual([first.filename, second.filename]);
    expect(stored[0].alt_text).toBe('A red door');
    expect(stored[1].alt_text).toHaveLength(images.MAX_ALT);
    expect(db.prepare('SELECT body FROM posts WHERE id = ?').get(id).body).toBe('hello #pictures');
    expect(db.prepare('SELECT COUNT(*) AS n FROM post_hashtags WHERE post_id = ?').get(id).n).toBe(1);
  });

  test('pictures alone are enough, and an empty post is not', () => {
    const a = makeUser('alice');
    const id = images.createPostWithImages({ authorId: a.id, body: '', images: [image()] });
    expect(db.prepare('SELECT body FROM posts WHERE id = ?').get(id).body).toBe('');

    const before = db.prepare('SELECT COUNT(*) AS n FROM posts').get().n;
    expect(errorOf(() => images.createPostWithImages({ authorId: a.id, body: '   ', images: [] }))).toBeInstanceOf(posts.PostError);
    expect(errorOf(() => images.createPostWithImages({ authorId: a.id, body: undefined, images: [] }))).toBeInstanceOf(posts.PostError);
    expect(db.prepare('SELECT COUNT(*) AS n FROM posts').get().n).toBe(before);
  });

  test('limits are enforced and nothing is half-saved', () => {
    const a = makeUser('alice');
    const before = db.prepare('SELECT COUNT(*) AS n FROM posts').get().n;
    const beforeImages = db.prepare('SELECT COUNT(*) AS n FROM post_images').get().n;

    expect(errorOf(() => images.createPostWithImages({ authorId: a.id, body: 'x'.repeat(281), images: [image()] }))).toBeInstanceOf(posts.PostError);
    expect(errorOf(() => images.createPostWithImages({ authorId: a.id, body: 'five', images: [1, 2, 3, 4, 5].map(() => image()) })).message).toMatch(/up to 4/);
    expect(errorOf(() => images.createPostWithImages({ authorId: a.id, body: 'reply', parentId: 999999, images: [image()] })).message).toMatch(/not found/);

    const same = fakeName();
    expect(errorOf(() => images.createPostWithImages({ authorId: a.id, body: 'dup', images: [image({ filename: same }), image({ filename: same })] }))).not.toBeNull();

    expect(db.prepare('SELECT COUNT(*) AS n FROM posts').get().n).toBe(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM post_images').get().n).toBe(beforeImages);
  });

  test('replies keep their parent, and deleting a post removes its picture rows', () => {
    const a = makeUser('alice');
    const root = images.createPostWithImages({ authorId: a.id, body: 'root', images: [image()] });
    const reply = images.createPostWithImages({ authorId: a.id, body: 'reply', parentId: root, images: [image()] });
    expect(db.prepare('SELECT parent_id FROM posts WHERE id = ?').get(reply).parent_id).toBe(root);

    db.prepare('DELETE FROM posts WHERE id = ?').run(root);
    expect(images.imagesFor(root)).toEqual([]);
    expect(images.imagesFor(reply)).toEqual([]);
  });

  test('deleting an account removes its picture rows', () => {
    const a = makeUser('alice');
    const id = images.createPostWithImages({ authorId: a.id, body: 'mine', images: [image()] });
    db.prepare('DELETE FROM users WHERE id = ?').run(a.id);
    expect(images.imagesFor(id)).toEqual([]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe('finding and removing files', () => {
  test('a thread lists the pictures of every reply, and only its author may trigger a cleanup', () => {
    const a = makeUser('alice');
    const b = makeUser('bob');
    const root = image();
    const reply = image();
    const nested = image();
    const other = image();
    const rootId = images.createPostWithImages({ authorId: a.id, body: 'root', images: [root] });
    const replyId = images.createPostWithImages({ authorId: b.id, body: 'reply', parentId: rootId, images: [reply] });
    images.createPostWithImages({ authorId: a.id, body: 'nested', parentId: replyId, images: [nested] });
    images.createPostWithImages({ authorId: a.id, body: 'unrelated', images: [other] });

    expect(images.collectThreadFilenames(rootId).sort()).toEqual([root.filename, reply.filename, nested.filename].sort());
    expect(images.deletableFilenames(rootId, a.id)).toHaveLength(3);
    expect(images.deletableFilenames(rootId, b.id)).toEqual([]);
    expect(images.deletableFilenames(999999, a.id)).toEqual([]);
  });

  test('only names that look exactly like uploads are ever deleted', () => {
    const good = fakeName('jpg');
    fs.writeFileSync(path.join(dir(), good), 'x');
    fs.writeFileSync(path.join(dir(), 'notes.txt'), 'x');
    fs.writeFileSync(path.join(path.dirname(dir()), 'outside.png'), 'x');

    expect(images.removeFiles([good, 'notes.txt', '../outside.png', '', null, 42, { a: 1 }], dir())).toBe(1);
    expect(fs.existsSync(path.join(dir(), good))).toBe(false);
    expect(fs.existsSync(path.join(dir(), 'notes.txt'))).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(dir()), 'outside.png'))).toBe(true);
    expect(images.removeFiles([good], dir())).toBe(0);
  });
});

let scratch;
const dir = () => {
  if (!scratch) {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'post-images-'));
    fs.mkdirSync(path.join(scratch, 'posts'));
  }
  return path.join(scratch, 'posts');
};
afterAll(() => scratch && fs.rmSync(scratch, { recursive: true, force: true }));

describe('the daily sweep', () => {
  function put(folder, name, ageHours) {
    const folderPath = path.join(scratch, folder);
    fs.mkdirSync(folderPath, { recursive: true });
    const file = path.join(folderPath, name);
    fs.writeFileSync(file, 'x');
    const when = new Date(Date.now() - ageHours * 3600 * 1000);
    fs.utimesSync(file, when, when);
    return file;
  }

  test('removes old post pictures nobody uses, and nothing else', () => {
    dir();
    const a = makeUser('alice');
    const used = fakeName();
    images.createPostWithImages({ authorId: a.id, body: 'keeps its picture', images: [image({ filename: used })] });

    const keep = put('posts', used, 72);
    const orphan = put('posts', fakeName(), 72);
    const fresh = put('posts', fakeName(), 1);
    const avatar = put('avatars', fakeName(), 72);
    const chat = put('chat', fakeName(), 72);
    const stray = put('posts', 'notes.txt', 72);

    expect(sweep.sweepOnce(db, { root: scratch, minAgeHours: 24 })).toEqual({ removed: 1, bytes: 1 });

    expect(fs.existsSync(orphan)).toBe(false);
    [keep, fresh, avatar, chat, stray].forEach((file) => expect(fs.existsSync(file)).toBe(true));
  });

  test('is scheduled shortly after the app starts, never while testing, and can be switched off', () => {
    const log = { log: jest.fn(), error: jest.fn() };
    expect(sweep.scheduleFromEnv(db, log)).toBeNull();

    const saved = { NODE_ENV: process.env.NODE_ENV, UPLOAD_SWEEP: process.env.UPLOAD_SWEEP };
    try {
      process.env.NODE_ENV = 'development';
      process.env.UPLOAD_SWEEP = 'false';
      expect(sweep.scheduleFromEnv(db, log)).toBeNull();

      delete process.env.UPLOAD_SWEEP;
      const job = sweep.scheduleFromEnv(db, log);
      expect(typeof job.stop).toBe('function');
      job.stop();
    } finally {
      Object.entries(saved).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    }
  });

  test('a failing sweep is logged and never thrown', () => {
    jest.useFakeTimers();
    try {
      const log = { log: jest.fn(), error: jest.fn() };
      const broken = { prepare: () => { throw new Error('database is locked'); } };
      const job = sweep.schedule({ db: broken, firstRunMs: 10, log });
      expect(() => jest.advanceTimersByTime(10)).not.toThrow();
      expect(log.error).toHaveBeenCalledWith('[uploads] sweep failed', expect.any(String));
      job.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});
