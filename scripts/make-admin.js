// Usage: node scripts/make-admin.js <username>          make an admin
//        node scripts/make-admin.js <username> revoke   remove admin rights
const db = require('../src/db');

const [username, mode] = process.argv.slice(2);
if (!username) {
  console.error('Usage: node scripts/make-admin.js <username> [revoke]');
  process.exit(1);
}

const value = mode === 'revoke' ? 0 : 1;
const result = db.prepare('UPDATE users SET is_admin = ? WHERE username = ? COLLATE NOCASE').run(value, username);
console.log(result.changes ? `${username} is ${value ? 'now an admin' : 'no longer an admin'}.` : `No user named "${username}".`);
