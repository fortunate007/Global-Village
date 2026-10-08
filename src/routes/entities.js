const express = require('express');
const discovery = require('../services/discoveryService');
const engagement = require('../services/engagementService');

const router = express.Router();

const ensureAuth = (req, res, next) => (req.isAuthenticated() ? next() : res.redirect('/login'));
const TAG_RE = /^[\p{L}\p{N}_]{1,50}$/u;

const viewerFor = (req, items) =>
  engagement.viewerState(req.user && req.user.id, engagement.collectIds(items));

router.get('/tags', (req, res) => {
  res.render('tags/index', { title: 'Trending', tags: discovery.trendingTags() });
});

router.get('/tags/:tag', (req, res) => {
  const tag = req.params.tag.toLowerCase();
  if (!TAG_RE.test(tag)) return res.status(404).render('404', { title: 'Not Found' });
  const items = discovery.postsByTag(tag);
  res.render('tags/show', { title: `#${tag}`, tag, items, ...viewerFor(req, items) });
});

router.get('/mentions', ensureAuth, (req, res) => {
  const items = discovery.postsMentioning(req.user.id);
  res.render('mentions', { title: 'Mentions', items, ...viewerFor(req, items) });
});

module.exports = router;
