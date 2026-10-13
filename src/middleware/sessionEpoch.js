const db = require('../db');

const readEpoch = db.prepare('SELECT session_epoch FROM users WHERE id = ?');

function currentEpoch(userId) {
  const row = readEpoch.get(userId);
  return row ? row.session_epoch : 0;
}

// Sessions created before this feature carry no stamp and count as 0, the starting value of every account
const stampOf = (req) => (req.session && Number.isInteger(req.session.authEpoch) ? req.session.authEpoch : 0);

function middleware(req, res, next) {
  // Every successful req.login (login page, registration, anything added later) records the counter
  const originalLogin = req.login;
  if (typeof originalLogin === 'function') {
    req.login = req.logIn = function login(user, options, done) {
      const hasOptions = typeof options !== 'function';
      const callback = hasOptions ? done : options;
      const stamped = (err) => {
        if (!err && req.session) req.session.authEpoch = currentEpoch(user.id);
        if (callback) callback(err);
      };
      return hasOptions ? originalLogin.call(req, user, options, stamped) : originalLogin.call(req, user, stamped);
    };
  }

  if (!req.user) return next();
  if (stampOf(req) === (req.user.session_epoch || 0)) return next();

  // The password was changed (or other devices were logged out) after this session started
  return req.logout((err) => next(err));
}

module.exports = { middleware, currentEpoch };
