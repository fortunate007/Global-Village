'use strict';

const path = require('path');
const crypto = require('crypto');
const session = require('express-session');

const DEV_SECRET = 'global-village-dev-secret';

// Production must never use the public development secret. If SESSION_SECRET is missing there,
// a random secret is used for this process (everyone is logged out on each restart) and a warning is printed.
function resolveSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;

  const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);
  if (!isProduction) return DEV_SECRET;

  console.warn(
    '[security] SESSION_SECRET is not set. Using a random secret for this process, so everyone is ' +
      'logged out on every restart. Set SESSION_SECRET in your hosting dashboard.'
  );
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Build the express-session middleware.
 *
 * Extracted from app.js so the exact same middleware instance can be mounted
 * on both the HTTP app and the Socket.IO engine. Sharing the store is what
 * lets authenticated sockets resolve the logged-in user.
 *
 * Tests use the in-memory store (no native module, no file on disk).
 * Everywhere else sessions persist to SQLite so logins survive a restart.
 *
 * @returns {import('express').RequestHandler}
 */
function createSessionMiddleware() {
  const isTest = process.env.NODE_ENV === 'test';
  const store = isTest
    ? undefined
    : new (require('connect-sqlite3')(session))({
        db: 'sessions.db',
        dir: path.join(__dirname, '..', '..', 'data'),
      });

  return session({
    store,
    secret: resolveSecret(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
      // Secure whenever the connection is HTTPS (behind a proxy this needs TRUST_PROXY=1)
      secure: 'auto',
    },
  });
}

module.exports = { createSessionMiddleware, resolveSecret };
