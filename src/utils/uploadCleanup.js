const fs = require('fs');
const path = require('path');

const UPLOADS_ROOT = path.join(__dirname, '..', 'public', 'uploads');
const UPLOAD_NAME = /^[0-9a-f]{32}\.(jpg|jpeg|png|gif|webp)$/;

// For each upload folder: the query that lists every URL the database still uses
const REFERENCES = {
  avatars: `SELECT avatar_url AS url FROM users WHERE avatar_url IS NOT NULL
            UNION SELECT avatar_url FROM groups WHERE avatar_url IS NOT NULL`,
  chat: 'SELECT image_url AS url FROM messages WHERE image_url IS NOT NULL',
};

// Files named like uploads that no row refers to and that are older than the grace period.
// Other files (.gitkeep, notes, anything not named like an upload) are never listed.
function findOrphans(db, { root = UPLOADS_ROOT, minAgeHours = 24, now = Date.now() } = {}) {
  const minAgeMs = minAgeHours * 3600 * 1000;
  const orphans = [];

  for (const [folder, sql] of Object.entries(REFERENCES)) {
    const dir = path.join(root, folder);
    if (!fs.existsSync(dir)) continue;

    const used = new Set(db.prepare(sql).all().map((row) => path.basename(String(row.url))));

    for (const name of fs.readdirSync(dir)) {
      if (!UPLOAD_NAME.test(name) || used.has(name)) continue;
      const file = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch (err) {
        continue;
      }
      if (!stat.isFile() || now - stat.mtimeMs < minAgeMs) continue;
      orphans.push({ folder, name, file, size: stat.size });
    }
  }
  return orphans;
}

function removeOrphans(orphans) {
  let removed = 0;
  let bytes = 0;
  for (const orphan of orphans) {
    try {
      fs.unlinkSync(orphan.file);
      removed += 1;
      bytes += orphan.size;
    } catch (err) {
      // already gone: nothing to do
    }
  }
  return { removed, bytes };
}

module.exports = { findOrphans, removeOrphans, UPLOADS_ROOT };
