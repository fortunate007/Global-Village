const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcryptjs');
const db = require('../db');

const NO_ACCOUNT = 'Incorrect username/email or password.';
const WRONG_PASSWORD = NO_ACCOUNT;

// Compared against when no account matches, so unknown names take as long as wrong passwords
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

module.exports = function configurePassport(passport) {
  passport.use(
    new LocalStrategy(
      { usernameField: 'username', passwordField: 'password' },
      (username, password, done) => {
        try {
          const candidates = db
            .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE')
            .all(username, username);

          if (!candidates.length) {
            bcrypt.compareSync(password, DUMMY_HASH);
            return done(null, false, { message: NO_ACCOUNT });
          }

          const user = candidates.find((u) => bcrypt.compareSync(password, u.password_hash));
          if (!user) return done(null, false, { message: WRONG_PASSWORD });

          // A suspended account cannot log in. This is revealed only after the correct password was
          // given, so it cannot be used to find out which usernames exist.
          if (user.suspended_at) return done(null, false, { message: 'This account has been suspended.' });

          return done(null, user);
        } catch (err) {
          return done(err);
        }
      }
    )
  );

  passport.serializeUser((user, done) => done(null, user.id));

  passport.deserializeUser((id, done) => {
    try {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      // The hash is only needed while logging in, never on the request user or in views
      if (user) delete user.password_hash;
      done(null, user);
    } catch (err) {
      done(err);
    }
  });
};
