const db = require('../src/db');
const posts = require('../src/services/postService');
const applyReportsKeep = require('../src/schema/reports-keep');

const makeUser = (name) =>
  Number(
    db
      .prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
      .run(name, `${name}@example.com`, 'x', name).lastInsertRowid
  );

test('a table from the earlier version is rebuilt with every row intact, and is safe to run again', () => {
  const author = makeUser('migauthor');
  const reporter = makeUser('migreporter');
  const postId = posts.createPost(author, 'old evidence');

  // Recreate the earlier table definition (reporter required, deleted with the account)
  db.exec('DROP TABLE reports');
  db.exec(`
    CREATE TABLE reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
      post_author_id INTEGER,
      post_body TEXT,
      reason TEXT NOT NULL CHECK (reason IN ('spam', 'abuse', 'harassment', 'misinformation', 'other')),
      details TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME,
      resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX idx_reports_once ON reports(reporter_id, post_id) WHERE post_id IS NOT NULL;
    CREATE INDEX idx_reports_status ON reports(status, created_at);
  `);
  const info = db
    .prepare(
      `INSERT INTO reports (reporter_id, post_id, post_author_id, post_body, reason, details)
       VALUES (?, ?, ?, 'old evidence', 'abuse', 'kept note')`
    )
    .run(reporter, postId, author);
  const id = Number(info.lastInsertRowid);

  applyReportsKeep(db);
  applyReportsKeep(db); // running it again changes nothing

  const column = db.prepare('PRAGMA table_info(reports)').all().find((c) => c.name === 'reporter_id');
  expect(column.notnull).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get().n).toBe(1);
  expect(db.prepare('SELECT * FROM reports WHERE id = ?').get(id)).toMatchObject({
    reporter_id: reporter,
    post_id: postId,
    post_body: 'old evidence',
    reason: 'abuse',
    details: 'kept note',
    status: 'open',
  });

  const indexes = db.prepare('PRAGMA index_list(reports)').all().map((i) => i.name);
  expect(indexes).toContain('idx_reports_once');
  expect(indexes).toContain('idx_reports_status');

  db.prepare('DELETE FROM users WHERE id = ?').run(reporter);
  expect(db.prepare('SELECT reporter_id FROM reports WHERE id = ?').get(id).reporter_id).toBeNull();
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
