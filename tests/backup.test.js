const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const backups = require('../src/services/backupService');

let dir;
let db;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backups-'));
  db = new Database(':memory:');
  db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
  db.prepare('INSERT INTO notes (body) VALUES (?)').run('one');
});
afterEach(() => {
  jest.useRealTimers();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const at = (seconds) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));
const names = () => backups.listBackups(dir);

describe('writing a backup', () => {
  test('is a complete copy with a dated name and private permissions', () => {
    db.prepare('INSERT INTO notes (body) VALUES (?)').run('two');
    const result = backups.backupNow(db, { dir, keep: 7, now: new Date(Date.UTC(2026, 9, 20, 12, 30, 5)) });

    expect(result.name).toBe('global-village-20261020-123005.db');
    expect(result.file).toBe(path.join(dir, result.name));
    expect(result.size).toBeGreaterThan(0);
    expect(result.removed).toEqual([]);

    const copy = new Database(result.file, { readonly: true });
    expect(copy.prepare('SELECT body FROM notes ORDER BY id').all().map((r) => r.body)).toEqual(['one', 'two']);
    copy.close();
    if (process.platform !== 'win32') expect(fs.statSync(result.file).mode & 0o777).toBe(0o600);
  });

  test('creates the folder when it is missing, and apostrophes in the path are fine', () => {
    const nested = path.join(dir, "it's", 'nested', 'backups');
    const result = backups.backupNow(db, { dir: nested, keep: 7, now: at(0) });
    expect(fs.existsSync(result.file)).toBe(true);
  });

  test('two backups in the same second never overwrite each other', () => {
    const first = backups.backupNow(db, { dir, keep: 7, now: at(1) });
    const second = backups.backupNow(db, { dir, keep: 7, now: at(1) });
    expect(second.name).not.toBe(first.name);
    expect(names()).toHaveLength(2);
  });

  test('old backups beyond the limit are removed automatically', () => {
    [0, 1, 2, 3].forEach((s) => backups.backupNow(db, { dir, keep: 2, now: at(s) }));
    expect(names()).toEqual(['global-village-20260101-000003.db', 'global-village-20260101-000002.db']);
  });
});

describe('listing and pruning', () => {
  test('lists newest first, ignores other files, and tolerates a missing folder', () => {
    [2, 0, 1].forEach((s) => backups.backupNow(db, { dir, keep: 99, now: at(s) }));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'global-village.db'), 'x');

    expect(names()).toEqual([
      'global-village-20260101-000002.db',
      'global-village-20260101-000001.db',
      'global-village-20260101-000000.db',
    ]);
    expect(backups.listBackups(path.join(dir, 'nowhere'))).toEqual([]);
  });

  test('pruning keeps the newest ones, never touches other files, and never deletes everything', () => {
    [0, 1, 2, 3, 4].forEach((s) => backups.backupNow(db, { dir, keep: 99, now: at(s) }));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');

    expect(backups.prune(dir, 2)).toHaveLength(3);
    expect(names()).toEqual(['global-village-20260101-000004.db', 'global-village-20260101-000003.db']);
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true);

    backups.prune(dir, 0);
    expect(names()).toHaveLength(1);
  });
});

describe('when a backup is due', () => {
  test('when there is none, or the newest is old enough', () => {
    expect(backups.dueForBackup(dir, 24, Date.now())).toBe(true);

    const { file } = backups.backupNow(db, { dir, keep: 7, now: at(0) });
    expect(backups.dueForBackup(dir, 24, Date.now())).toBe(false);

    const old = new Date(Date.now() - 25 * 3600 * 1000);
    fs.utimesSync(file, old, old);
    expect(backups.dueForBackup(dir, 24, Date.now())).toBe(true);
    expect(backups.dueForBackup(dir, 48, Date.now())).toBe(false);
  });
});

describe('the schedule', () => {
  test('writes a backup shortly after starting, then only when one is due, and can be stopped', () => {
    jest.useFakeTimers();
    const log = { log: jest.fn(), error: jest.fn() };
    const job = backups.schedule({ db, dir, keep: 3, hours: 24, firstRunMs: 1000, checkEveryMs: 3600000, log });

    expect(names()).toHaveLength(0);
    jest.advanceTimersByTime(1000);
    expect(names()).toHaveLength(1);
    expect(log.log).toHaveBeenCalledWith(expect.stringContaining('[backup] wrote'));

    jest.advanceTimersByTime(3600000);
    expect(names()).toHaveLength(1);

    job.stop();
    jest.advanceTimersByTime(48 * 3600000);
    expect(names()).toHaveLength(1);
  });

  test('a failing backup is logged and never thrown', () => {
    jest.useFakeTimers();
    const blocker = path.join(dir, 'a-file');
    fs.writeFileSync(blocker, 'x');
    const log = { log: jest.fn(), error: jest.fn() };
    const job = backups.schedule({ db, dir: path.join(blocker, 'sub'), firstRunMs: 10, log });

    expect(() => jest.advanceTimersByTime(10)).not.toThrow();
    expect(log.error).toHaveBeenCalledWith('[backup] backup failed', expect.any(String));
    job.stop();
  });
});

describe('settings', () => {
  const KEYS = ['NODE_ENV', 'BACKUP_ENABLED', 'BACKUP_DIR', 'BACKUP_KEEP', 'BACKUP_INTERVAL_HOURS'];
  const saved = {};
  beforeEach(() => KEYS.forEach((k) => { saved[k] = process.env[k]; }));
  afterEach(() =>
    KEYS.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    })
  );

  test('numbers fall back to the defaults when they are missing or out of range', () => {
    delete process.env.BACKUP_KEEP;
    delete process.env.BACKUP_INTERVAL_HOURS;
    expect(backups.keepCount()).toBe(7);
    expect(backups.intervalHours()).toBe(24);

    ['0', '1000', 'x', ''].forEach((value) => {
      process.env.BACKUP_KEEP = value;
      expect(backups.keepCount()).toBe(7);
    });
    process.env.BACKUP_KEEP = '2.7';
    expect(backups.keepCount()).toBe(2);
    process.env.BACKUP_KEEP = '30';
    expect(backups.keepCount()).toBe(30);

    process.env.BACKUP_INTERVAL_HOURS = '6';
    expect(backups.intervalHours()).toBe(6);
    process.env.BACKUP_INTERVAL_HOURS = '999';
    expect(backups.intervalHours()).toBe(24);
  });

  test('nothing is scheduled while testing, BACKUP_ENABLED=false switches it off, and otherwise it runs', () => {
    const log = { log: jest.fn(), error: jest.fn() };
    expect(backups.scheduleFromEnv(db, log)).toBeNull();

    process.env.NODE_ENV = 'development';
    process.env.BACKUP_ENABLED = 'false';
    expect(backups.scheduleFromEnv(db, log)).toBeNull();
    expect(log.log).toHaveBeenCalledWith(expect.stringContaining('switched off'));

    delete process.env.BACKUP_ENABLED;
    process.env.BACKUP_DIR = dir;
    expect(backups.backupDir()).toBe(dir);
    const job = backups.scheduleFromEnv(db, log);
    expect(typeof job.stop).toBe('function');
    job.stop();
  });
});

describe('the command-line tool', () => {
  const run = (...args) =>
    spawnSync(process.execPath, ['scripts/backup.js', ...args], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, NODE_ENV: 'test', BACKUP_DIR: dir },
      encoding: 'utf8',
    });

  test('lists and writes backups', () => {
    const empty = run('--list');
    expect(empty.status).toBe(0);
    expect(empty.stdout).toMatch(/No backups/);

    const made = run();
    expect(made.status).toBe(0);
    expect(made.stdout).toMatch(/Backup written/);
    expect(names()).toHaveLength(1);

    const listed = run('--list');
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain('1 backup(s)');
    expect(listed.stdout).toContain(names()[0]);
  });
});

describe('the project files', () => {
  test('the app starts the schedule only when it is run directly', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
    expect(app).toMatch(/if \(require\.main === module\) \{\s*require\('\.\/services\/backupService'\)\.scheduleFromEnv\(db\);/);
  });

  test('backups and database files are ignored by git', () => {
    const ignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8').split('\n');
    ['data/backups/', 'data/*.db', 'data/*.db-shm', 'data/*.db-wal'].forEach((pattern) => expect(ignore).toContain(pattern));
  });

  test('package.json offers the backup shortcut', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    expect(pkg.scripts.backup).toBe('node scripts/backup.js');
  });
});
