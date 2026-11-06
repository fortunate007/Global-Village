// Usage: node scripts/migrate.js status    show which migrations have run and which are waiting
// Waiting migrations are applied automatically the next time the app starts.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { status } = require('../src/migrations/runner');

const [command = 'status'] = process.argv.slice(2);
if (command !== 'status') {
  console.error('Usage: node scripts/migrate.js status');
  process.exit(1);
}

const file = path.join(__dirname, '..', 'data', 'global-village.db');
if (!fs.existsSync(file)) {
  console.log(`No database found at ${file}.`);
  process.exit(0);
}

const db = new Database(file, { fileMustExist: true });
const { applied, pending } = status(db);
console.log(`${applied.length} applied, ${pending.length} pending.`);
applied.forEach((m) => console.log(`  applied  ${m.name}  ${m.applied_at}`));
pending.forEach((name) => console.log(`  pending  ${name}  (applied the next time the app starts)`));
db.close();
