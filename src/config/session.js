'use strict';

const path = require('path');
const session = require('express-session');

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
    secret: process.env.SESSION_SECRET || 'global-village-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 },
  });
}

module.exports = { createSessionMiddleware };
