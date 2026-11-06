const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = __dirname;
// 0001_short_name.js, 0002_other_name.js ... applied in number order
const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.js$/;

// Names (without .js) of the migration files in a folder, in order. Two files may not share a number.
function listMigrations(dir) {
  const files = fs.readdirSync(dir).filter((file) => FILE_PATTERN.test(file)).sort();
  const seen = new Map();
  for (const file of files) {
    const number = file.slice(0, 4);
    if (seen.has(number)) {
      throw new Error(`Migrations ${seen.get(number)} and ${file} share the number ${number}. Each migration needs its own number.`);
    }
    seen.set(number, file);
  }
  return files.map((file) => file.replace(/\.js$/, ''));
}

const hasTable = (db) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();

// Applies every migration that has not run yet. Each one runs inside a transaction together with the note that
// records it, so a failure undoes that migration completely, later ones do not run, and the error names it.
// A migration is a file exporting { up(db) }. Do not change PRAGMA foreign_keys inside up(): SQLite ignores it in a transaction.
function applyMigrations(db, { dir = DEFAULT_DIR, log = console } = {}) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)'
  );
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((row) => row.name));
  const applied = [];

  for (const name of listMigrations(dir)) {
    if (done.has(name)) continue;

    const migration = require(path.join(dir, `${name}.js`));
    if (!migration || typeof migration.up !== 'function') {
      throw new Error(`Migration ${name} must export an up(db) function`);
    }
    try {
      db.transaction(() => {
        migration.up(db);
        db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name);
      })();
    } catch (err) {
      err.message = `Migration ${name} failed: ${err.message}`;
      throw err;
    }
    applied.push(name);
    if (log && process.env.NODE_ENV !== 'test') log.log(`[migrations] applied ${name}`);
  }
  return applied;
}

// What has run and what is waiting. Changes nothing.
function status(db, { dir = DEFAULT_DIR } = {}) {
  const applied = hasTable(db) ? db.prepare('SELECT name, applied_at FROM schema_migrations ORDER BY name').all() : [];
  const done = new Set(applied.map((row) => row.name));
  return { applied, pending: listMigrations(dir).filter((name) => !done.has(name)) };
}

module.exports = { applyMigrations, status, listMigrations, DEFAULT_DIR };
