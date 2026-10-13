// Usage: node scripts/prune-sessions.js                 count stored and expired sessions (dry run)
//        node scripts/prune-sessions.js --delete        delete the expired ones
//        node scripts/prune-sessions.js --file=PATH     use a different sessions database
// Live sessions are never touched. Run it where the sessions database lives (on Render: its shell).
const path = require('path');
const { inspect, prune, DEFAULT_FILE } = require('../src/services/sessionMaintenance');

const args = process.argv.slice(2);
const doDelete = args.includes('--delete');
const fileArg = args.find((a) => a.startsWith('--file='));
const file = fileArg ? path.resolve(fileArg.slice('--file='.length)) : DEFAULT_FILE;

const info = inspect(file);
if (info.skipped) {
  console.log(`Nothing to do: ${info.skipped}.`);
  process.exit(0);
}

console.log(`${info.total} stored session(s), ${info.expired} expired.`);
if (!info.expired) process.exit(0);

if (!doDelete) {
  console.log('Nothing was deleted. Run again with --delete to remove the expired ones.');
} else {
  const result = prune(file);
  console.log(`Deleted ${result.deleted} expired session(s), ${result.remaining} remain.`);
}
