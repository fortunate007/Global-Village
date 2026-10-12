const db = require('../db');
const safety = require('./safetyService');

// Current members who may see something the sender did: everyone except people who blocked the
// sender or were blocked by them. The sender always gets their own update if still a member.
function recipientsFor(groupId, senderId) {
  const members = db
    .prepare('SELECT user_id FROM group_members WHERE group_id = ?')
    .all(groupId)
    .map((r) => r.user_id);
  const blockedWithSender = safety.blockedIds(senderId);
  return members.filter((id) => id === senderId || !blockedWithSender.has(id));
}

// Pushes an event about a stored group message to each allowed member's private room
// (user:<id>, joined in realtime/index.js). Returns how many rooms were notified. Never throws:
// a failed push must not fail the request, because the change is already saved.
function push(io, messageId, event, buildPayload) {
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

    const payload = buildPayload(message);
    const recipients = recipientsFor(message.group_id, message.sender_id);
    recipients.forEach((id) => io.to(`user:${id}`).emit(event, payload));
    return recipients.length;
  } catch (err) {
    console.error('[groups] live delivery failed', err);
    return 0;
  }
}

const broadcastGroupMessage = (io, messageId) => push(io, messageId, 'group:new', (m) => m);
const broadcastGroupEdit = (io, messageId) =>
  push(io, messageId, 'group:edited', (m) => ({ id: m.id, group_id: m.group_id, body: m.body }));
const broadcastGroupDelete = (io, messageId) =>
  push(io, messageId, 'group:deleted', (m) => ({ id: m.id, group_id: m.group_id }));

module.exports = { broadcastGroupMessage, broadcastGroupEdit, broadcastGroupDelete };
