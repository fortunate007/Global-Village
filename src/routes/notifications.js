const express = require('express');
const notifications = require('../services/notificationService');
const follows = require('../services/followService');

const router = express.Router();

const ensureAuth = (req, res, next) => (req.isAuthenticated() ? next() : res.redirect('/login'));

router.get('/notifications', ensureAuth, (req, res) => {
  const items = notifications.list(req.user.id);
  items.forEach((n) => { n.canFollowBack = n.type === 'follow' && !follows.isFollowing(req.user.id, n.actor_id); });
  notifications.markAllRead(req.user.id);
  res.locals.unreadNotifications = 0;
  res.render('notifications', { title: 'Notifications', items });
});

module.exports = router;
