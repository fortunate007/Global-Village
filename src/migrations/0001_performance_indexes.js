// Indexes for queries that order messages by time and for the "people" list
module.exports = {
  up(db) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_group_created ON messages(group_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_dm_created ON messages(sender_id, recipient_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen);
    `);
  },
};
