const db = require('../db');
const notifications = require('../services/notificationService');

// Only notifications created after startup are pushed
let lastId = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM notifications').get().id;

// Sends each new notification to its owner's private room (user:<id>, joined in realtime/index.js)
function relay(io) {
  if (!io) return 0;
  const fresh = notifications.listAfter(lastId);
  for (const n of fresh) {
    io.to(`user:${n.user_id}`).emit('notification:new', {
      id: n.id,
      type: n.type,
      text: `${n.display_name} ${n.verb}`,
      href: n.href,
      unread: notifications.unreadCount(n.user_id),
    });
    lastId = n.id;
  }
  return fresh.length;
}

// Express middleware: runs the relay after every non-GET request has been answered
function middleware(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.once('finish', () => {
      try {
        relay(req.app.get('io'));
      } catch (err) {
        console.error('[notifications] relay failed', err);
      }
    });
  }
  next();
}

module.exports = { relay, middleware };
