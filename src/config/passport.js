const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcryptjs');
const db = require('../db');

module.exports = function configurePassport(passport) {
  passport.use(
    new LocalStrategy(
      { usernameField: 'username', passwordField: 'password' },
      (username, password, done) => {
        try {
          const user = db
            .prepare('SELECT * FROM users WHERE username = ? OR email = ?')
            .get(username, username);

          if (!user) {
            return done(null, false, { message: 'No account with that username/email.' });
          }

          const matches = bcrypt.compareSync(password, user.password_hash);
          if (!matches) {
            return done(null, false, { message: 'Incorrect password.' });
          }

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
      done(null, user);
    } catch (err) {
      done(err);
    }
  });
};
