const db = require('../db');
const safety = require('./safetyService');

// Pushes a stored group message to every current member's private room (user:<id>, joined in
// realtime/index.js). Members who blocked the sender, or were blocked by them, are skipped, and so
// are people who already left. Returns how many rooms were notified. Never throws: a failed
// push must not fail the request, because the message is already saved.
function broadcastGroupMessage(io, messageId) {
  if (!io) return 0;
  try {
    const message = db
      .prepare(
        `SELECT m.*, u.display_name AS sender_name, u.avatar_url AS sender_avatar
         FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.id = ? AND m.group_id IS NOT NULL`
      )
      .get(messageId);
    if (!message) return 0;

    const members = db
      .prepare('SELECT user_id FROM group_members WHERE group_id = ?')
      .all(message.group_id)
      .map((r) => r.user_id);

    const blockedWithSender = safety.blockedIds(message.sender_id);
    let sent = 0;
    for (const memberId of members) {
      if (memberId !== message.sender_id && blockedWithSender.has(memberId)) continue;
      io.to(`user:${memberId}`).emit('group:new', message);
      sent += 1;
    }
    return sent;
  } catch (err) {
    console.error('[groups] live delivery failed', err);
    return 0;
  }
}

module.exports = { broadcastGroupMessage };
