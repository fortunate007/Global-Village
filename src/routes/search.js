const express = require('express');
const search = require('../services/searchService');
const engagement = require('../services/engagementService');
const { PROFILE_PATH } = require('../utils/linkify');

const router = express.Router();
const TYPES = ['all', 'posts', 'people', 'tags'];

router.get('/search', (req, res) => {
  const type = TYPES.includes(req.query.type) ? req.query.type : 'all';
  const page = Math.min(50, Math.max(1, parseInt(req.query.page, 10) || 1));
  const results = search.search(req.query.q, type, page);

  res.render('search', {
    title: 'Search',
    ...results,
    type,
    page,
    profilePath: PROFILE_PATH,
    ...engagement.viewerState(req.user && req.user.id, engagement.collectIds(results.posts)),
  });
});

module.exports = router;
