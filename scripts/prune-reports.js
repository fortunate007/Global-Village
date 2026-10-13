// Usage: node scripts/prune-reports.js                  count old resolved/dismissed reports (dry run)
//        node scripts/prune-reports.js --delete         delete them
//        node scripts/prune-reports.js --days=180       change the age limit (default 90)
// Open reports are never removed. Run it where the database lives (on Render: its shell).
require('../src/db');
const safety = require('../src/services/safetyService');

const args = process.argv.slice(2);
const doDelete = args.includes('--delete');
const daysArg = args.find((a) => a.startsWith('--days='));
const days = daysArg ? Number(daysArg.split('=')[1]) : 90;

if (!Number.isInteger(days) || days < 1) {
  console.error('--days must be a whole number, 1 or more.');
  process.exit(1);
}

const count = safety.countPrunable(days);
if (!count) {
  console.log(`No resolved or dismissed reports older than ${days} days.`);
  process.exit(0);
}

if (!doDelete) {
  console.log(`${count} resolved or dismissed report(s) older than ${days} days. Nothing was deleted. Run again with --delete to remove them.`);
} else {
  console.log(`Deleted ${safety.pruneResolved(days)} report(s) older than ${days} days.`);
}
