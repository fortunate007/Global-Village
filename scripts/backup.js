// Usage: node scripts/backup.js           write a backup now (older ones beyond BACKUP_KEEP are removed)
//        node scripts/backup.js --list    list the existing backups
// Backups contain private data (password hashes, messages). Keep them private and never commit them.
const fs = require('fs');
const path = require('path');
const backups = require('../src/services/backupService');

const size = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`);

if (process.argv.includes('--list')) {
  const dir = backups.backupDir();
  const list = backups.listBackups(dir);
  if (!list.length) {
    console.log(`No backups in ${dir}.`);
  } else {
    console.log(`${list.length} backup(s) in ${dir}:`);
    list.forEach((name) => console.log(`  ${name}  ${size(fs.statSync(path.join(dir, name)).size)}`));
  }
  process.exit(0);
}

const db = require('../src/db');
const result = backups.backupNow(db);
console.log(`Backup written: ${result.file} (${size(result.size)})`);
if (result.removed.length) console.log(`Removed ${result.removed.length} old backup(s).`);
