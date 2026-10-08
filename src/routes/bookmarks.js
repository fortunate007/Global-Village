const express = require('express');
const engagement = require('../services/engagementService');

const router = express.Router();

const ensureAuth = (req, res, next) => (req.isAuthenticated() ? next() : res.redirect('/login'));

router.get('/bookmarks', ensureAuth, (req, res) => {
  const items = engagement.listBookmarks(req.user.id);
  res.render('bookmarks', {
    title: 'Bookmarks',
    items,
    ...engagement.viewerState(req.user.id, engagement.collectIds(items)),
  });
});

module.exports = router;
