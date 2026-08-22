const db = require('../db');

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  req.flash('error', 'Please log in to continue.');
  res.redirect('/login');
}

function ensureGuest(req, res, next) {
  if (!req.isAuthenticated()) return next();
  res.redirect('/users');
}

// Updates last_seen every request so we can derive "online" status
function touchLastSeen(req, res, next) {
  if (req.isAuthenticated()) {
    db.prepare('UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(req.user.id);
  }
  next();
}

module.exports = { ensureAuthenticated, ensureGuest, touchLastSeen };
