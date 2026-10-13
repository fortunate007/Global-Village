const express = require('express');
const db = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');
const follows = require('../services/followService');
const safety = require('../services/safetyService');

const router = express.Router();

router.post('/follow/:id', ensureAuthenticated, (req, res) => {
  try {
    const result = follows.follow(req.user.id, req.params.id);
    if (result.changed) {
      const target = db.prepare('SELECT display_name FROM users WHERE id = ?').get(Number(req.params.id));
      req.flash('success', `You are now following ${target.display_name}.`);
    }
  } catch (err) {
    if (!(err instanceof follows.FollowError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect('back');
});

router.post('/unfollow/:id', ensureAuthenticated, (req, res) => {
  follows.unfollow(req.user.id, req.params.id);
  res.redirect('back');
});

const listPage = (kind, heading) => (req, res) => {
  const owner = db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(Number(req.params.id));
  if (!owner || safety.blockedEitherWay(req.user.id, owner.id)) {
    req.flash('error', 'User not found.');
    return res.redirect('/users');
  }
  res.render('follows', {
    title: `${owner.display_name} · ${heading}`,
    heading,
    owner,
    people: follows.list(kind, owner.id, req.user.id),
  });
};

router.get('/profile/:id/followers', ensureAuthenticated, listPage('followers', 'Followers'));
router.get('/profile/:id/following', ensureAuthenticated, listPage('following', 'Following'));

module.exports = router;
