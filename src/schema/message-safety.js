module.exports = function applyMessageSafetySchema(db) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS safety_message_bi BEFORE INSERT ON messages
    WHEN new.recipient_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM blocks b
      WHERE (b.blocker_id = new.sender_id AND b.blocked_id = new.recipient_id)
         OR (b.blocker_id = new.recipient_id AND b.blocked_id = new.sender_id)
    )
    BEGIN SELECT RAISE(ABORT, 'blocked'); END;
  `);
};
