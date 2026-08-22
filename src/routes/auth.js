const express = require('express');
const passport = require('passport');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { ensureGuest } = require('../middleware/auth');

const router = express.Router();

router.get('/', (req, res) => {
  res.redirect(req.isAuthenticated() ? '/users' : '/login');
});

router.get('/register', ensureGuest, (req, res) => {
  res.render('register', { title: 'Register' });
});

router.post('/register', ensureGuest, (req, res) => {
  const { username, email, password, confirmPassword, displayName } = req.body;
  const errors = [];

  if (!username || !email || !password || !confirmPassword) {
    errors.push('Please fill in all required fields.');
  }
  if (username && !/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    errors.push('Username must be 3-20 characters: letters, numbers, underscores only.');
  }
  if (password && password.length < 6) {
    errors.push('Password must be at least 6 characters.');
  }
  if (password !== confirmPassword) {
    errors.push('Passwords do not match.');
  }

  if (errors.length) {
    return res.render('register', {
      title: 'Register',
      errors,
      formData: { username, email, displayName },
    });
  }

  try {
    const existing = db
      .prepare('SELECT id FROM users WHERE username = ? OR email = ?')
      .get(username, email);
    if (existing) {
      return res.render('register', {
        title: 'Register',
        errors: ['That username or email is already taken.'],
        formData: { username, email, displayName },
      });
    }

    const hash = bcrypt.hashSync(password, 10);
    const info = db
      .prepare(
        `INSERT INTO users (username, email, password_hash, display_name)
         VALUES (?, ?, ?, ?)`
      )
      .run(username, email, hash, displayName && displayName.trim() ? displayName.trim() : username);

    req.login({ id: info.lastInsertRowid }, (err) => {
      if (err) {
        req.flash('error', 'Account created, please log in.');
        return res.redirect('/login');
      }
      res.redirect('/users');
    });
  } catch (err) {
    console.error(err);
    res.render('register', {
      title: 'Register',
      errors: ['Something went wrong. Please try again.'],
      formData: { username, email, displayName },
    });
  }
});

router.get('/login', ensureGuest, (req, res) => {
  res.render('login', { title: 'Log In' });
});

router.post('/login', ensureGuest, (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      req.flash('error', (info && info.message) || 'Invalid credentials.');
      return res.redirect('/login');
    }
    req.login(user, (err2) => {
      if (err2) return next(err2);
      res.redirect('/users');
    });
  })(req, res, next);
});

router.post('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    res.redirect('/login');
  });
});

module.exports = router;
