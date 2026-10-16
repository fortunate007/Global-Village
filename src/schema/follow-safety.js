const PAIR = `(b.blocker_id = follows.follower_id AND b.blocked_id = follows.followee_id)
        OR (b.blocker_id = follows.followee_id AND b.blocked_id = follows.follower_id)`;

module.exports = function applyFollowSafetySchema(db) {
  const columns = db.prepare("SELECT name FROM pragma_table_info('follows')").all().map((c) => c.name);
  if (!columns.includes('follower_id') || !columns.includes('followee_id')) {
    console.warn('[follow-safety] the follows table was not found or looks different, so follow protection was not installed');
    return false;
  }

  db.exec(`
    -- Blocking removes follows in both directions
    CREATE TRIGGER IF NOT EXISTS safety_block_follows_ai AFTER INSERT ON blocks BEGIN
      DELETE FROM follows
      WHERE (follower_id = new.blocker_id AND followee_id = new.blocked_id)
         OR (follower_id = new.blocked_id AND followee_id = new.blocker_id);
    END;

    -- A follow between blocked people is silently ignored (reveals nothing, like friend requests)
    CREATE TRIGGER IF NOT EXISTS safety_follow_bi BEFORE INSERT ON follows
    WHEN EXISTS (
      SELECT 1 FROM blocks b
      WHERE (b.blocker_id = new.follower_id AND b.blocked_id = new.followee_id)
         OR (b.blocker_id = new.followee_id AND b.blocked_id = new.follower_id)
    )
    BEGIN SELECT RAISE(IGNORE); END;

    -- Clears follows left over from blocks made before this protection existed
    DELETE FROM follows WHERE EXISTS (SELECT 1 FROM blocks b WHERE ${PAIR});
  `);
  return true;
};
