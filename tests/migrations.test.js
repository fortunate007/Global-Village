const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { applyMigrations, status, listMigrations, DEFAULT_DIR } = require('../src/migrations/runner');

let dir;
let db;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'));
  db = new Database(':memory:');
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (name, body) => fs.writeFileSync(path.join(dir, name), body);
const create = (table) => `module.exports = { up(db) { db.exec('CREATE TABLE ${table} (id INTEGER)'); } };`;
const tables = () =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
const recorded = () => db.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map((r) => r.name);

describe('applying migrations', () => {
  test('runs pending migrations in number order, records them and never runs one twice', () => {
    write('0002_second.js', create('second'));
    write('0001_first.js', create('first'));
    write('notes.txt', 'ignored');
    write('helper.js', 'throw new Error("not a migration")');

    expect(applyMigrations(db, { dir, log: null })).toEqual(['0001_first', '0002_second']);
    expect(tables()).toEqual(['first', 'schema_migrations', 'second']);
    expect(recorded()).toEqual(['0001_first', '0002_second']);

    expect(applyMigrations(db, { dir, log: null })).toEqual([]);

    write('0003_third.js', create('third'));
    expect(applyMigrations(db, { dir, log: null })).toEqual(['0003_third']);
    expect(tables()).toContain('third');
  });

  test('a failing migration is rolled back completely, named in the error, and later ones do not run', () => {
    write('0001_first.js', create('first'));
    write('0002_bad.js', "module.exports = { up(db) { db.exec('CREATE TABLE half (id INTEGER)'); throw new Error('boom'); } };");
    write('0003_after.js', create('after'));

    let error;
    try {
      applyMigrations(db, { dir, log: null });
    } catch (err) {
      error = err;
    }
    expect(error.message).toMatch(/Migration 0002_bad failed: boom/);

    expect(tables()).toEqual(['first', 'schema_migrations']);
    expect(recorded()).toEqual(['0001_first']);
  });

  test('a migration that can be fixed runs on the next start', () => {
    write('0001_flaky.js', "module.exports = { up() { throw new Error('not yet'); } };");
    expect(() => applyMigrations(db, { dir, log: null })).toThrow(/not yet/);

    write('0001_flaky.js', create('fixed'));
    jest.resetModules();
    expect(applyMigrations(db, { dir, log: null })).toEqual(['0001_flaky']);
    expect(tables()).toContain('fixed');
  });

  test('files without an up function, and duplicate numbers, are refused', () => {
    write('0001_empty.js', 'module.exports = {};');
    expect(() => applyMigrations(db, { dir, log: null })).toThrow(/must export an up\(db\) function/);

    write('0001_other.js', create('other'));
    expect(() => applyMigrations(db, { dir, log: null })).toThrow(/share the number 0001/);
    expect(() => listMigrations(dir)).toThrow(/share the number 0001/);
  });
});

describe('status', () => {
  test('lists what has run and what is waiting, without changing anything', () => {
    write('0001_first.js', create('first'));
    write('0002_second.js', create('second'));

    expect(status(db, { dir })).toEqual({ applied: [], pending: ['0001_first', '0002_second'] });
    expect(tables()).toEqual([]);

    db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.prepare("INSERT INTO schema_migrations (name) VALUES ('0001_first')").run();
    const result = status(db, { dir });
    expect(result.applied.map((m) => m.name)).toEqual(['0001_first']);
    expect(result.pending).toEqual(['0002_second']);
  });
});

describe('the real migrations', () => {
  test('are named correctly, and the app has applied them with their effects', () => {
    const names = listMigrations(DEFAULT_DIR);
    expect(names).toContain('0001_performance_indexes');
    names.forEach((name) => expect(name).toMatch(/^\d{4}_[a-z0-9_]+$/));

    const appDb = require('../src/db');
    const applied = appDb.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name);
    expect(applied).toEqual(expect.arrayContaining(names));

    const indexes = appDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
    ['idx_messages_group_created', 'idx_messages_dm_created', 'idx_users_last_seen'].forEach((index) => {
      expect(indexes).toContain(index);
    });
  });

  test('applying them again changes nothing', () => {
    const appDb = require('../src/db');
    expect(applyMigrations(appDb, { log: null })).toEqual([]);
  });
});
