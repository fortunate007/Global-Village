const express = require('express');
const notifications = require('../services/notificationService');

const router = express.Router();

const ensureAuth = (req, res, next) => (req.isAuthenticated() ? next() : res.redirect('/login'));

router.get('/notifications', ensureAuth, (req, res) => {
  const items = notifications.list(req.user.id);
  notifications.markAllRead(req.user.id);
  res.locals.unreadNotifications = 0;
  res.render('notifications', { title: 'Notifications', items, verbs: notifications.VERBS });
});

module.exports = router;
