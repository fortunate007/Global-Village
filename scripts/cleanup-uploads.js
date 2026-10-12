// Usage: node scripts/cleanup-uploads.js                         list unused upload files (dry run)
//        node scripts/cleanup-uploads.js --delete                delete them
//        node scripts/cleanup-uploads.js --min-age-hours=48      skip files newer than this (default 24)
// Run it on the machine that holds both the database and the uploads folder.
const db = require('../src/db');
const { findOrphans, removeOrphans } = require('../src/utils/uploadCleanup');

const args = process.argv.slice(2);
const doDelete = args.includes('--delete');
const ageArg = args.find((a) => a.startsWith('--min-age-hours='));
const minAgeHours = ageArg ? Number(ageArg.split('=')[1]) : 24;

if (!Number.isFinite(minAgeHours) || minAgeHours < 0) {
  console.error('--min-age-hours must be a number of hours, 0 or more.');
  process.exit(1);
}

if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
  console.error('The database has no users, so every file would look unused. Refusing to continue.');
  process.exit(1);
}

const formatSize = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`);

const orphans = findOrphans(db, { minAgeHours });
if (!orphans.length) {
  console.log(`No unused upload files older than ${minAgeHours} hours.`);
  process.exit(0);
}

const total = orphans.reduce((sum, o) => sum + o.size, 0);
orphans.forEach((o) => console.log(`${o.folder}/${o.name}  ${formatSize(o.size)}`));

if (!doDelete) {
  console.log(`\n${orphans.length} unused file(s), ${formatSize(total)}. Nothing was deleted. Run again with --delete to remove them.`);
} else {
  const { removed, bytes } = removeOrphans(orphans);
  console.log(`\nDeleted ${removed} file(s), freed ${formatSize(bytes)}.`);
}
