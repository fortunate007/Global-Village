const express = require('express');
const posts = require('../services/postService');
const engagement = require('../services/engagementService');
const safety = require('../services/safetyService');

const router = express.Router();

const ensureAuth = (req, res, next) => (req.isAuthenticated() ? next() : res.redirect('/login'));
const viewerId = (req) => (req.user ? req.user.id : null);

// Runs a service call; user-facing errors become flash messages, others hit the error handler
const action = (fn, redirectTo) => (req, res, next) => {
  try {
    const result = fn(req);
    res.redirect(redirectTo ? redirectTo(result, req) : 'back');
  } catch (err) {
    if (err instanceof posts.PostError) {
      req.flash('error', err.message);
      return res.redirect('back');
    }
    if (safety.isBlockError(err)) {
      req.flash('error', "You can't interact with that account.");
      return res.redirect('back');
    }
    next(err);
  }
};

const viewerFor = (req, ...lists) =>
  engagement.viewerState(viewerId(req), engagement.collectIds(...lists));

router.get('/', (req, res) => {
  const feed = safety.filterPosts(viewerId(req), posts.feed());
  res.render('posts/index', { title: 'Posts', feed, maxLength: posts.MAX_LENGTH, ...viewerFor(req, feed) });
});

router.get('/:id(\\d+)', (req, res) => {
  const thread = safety.filterThread(viewerId(req), posts.getThread(Number(req.params.id)));
  if (!thread) return res.status(404).render('404', { title: 'Not Found' });
  if (thread.post.repost_of_id) return res.redirect(`/posts/${thread.post.repost_of_id}`);
  res.render('posts/show', {
    title: 'Post',
    ...thread,
    maxLength: posts.MAX_LENGTH,
    ...viewerFor(req, thread.ancestors, [thread.post], thread.replies),
  });
});

router.get('/:id(\\d+)/history', (req, res) => {
  const id = Number(req.params.id);
  const thread = safety.filterThread(viewerId(req), posts.getThread(id));
  if (!thread || thread.post.repost_of_id) return res.status(404).render('404', { title: 'Not Found' });
  res.render('posts/history', { title: 'Edit history', post: thread.post, edits: posts.getHistory(id) });
});

router.get('/:id(\\d+)/edit', ensureAuth, (req, res, next) => {
  const id = Number(req.params.id);
  try {
    const post = posts.getForEdit(req.user.id, id);
    res.render('posts/edit', { title: 'Edit post', post, maxLength: posts.MAX_LENGTH });
  } catch (err) {
    if (!(err instanceof posts.PostError)) return next(err);
    req.flash('error', err.message);
    res.redirect(`/posts/${id}`);
  }
});

router.post('/', ensureAuth, action((req) => posts.createPost(req.user.id, req.body.body), () => '/posts'));
router.post(
  '/:id(\\d+)/edit',
  ensureAuth,
  action((req) => posts.editPost(req.user.id, Number(req.params.id), req.body.body), (id) => `/posts/${id}`)
);
router.post(
  '/:id(\\d+)/reply',
  ensureAuth,
  action((req) => posts.reply(req.user.id, Number(req.params.id), req.body.body), (_r, req) => `/posts/${req.params.id}`)
);
router.post(
  '/:id(\\d+)/quote',
  ensureAuth,
  action((req) => posts.quote(req.user.id, Number(req.params.id), req.body.body), (newId) => `/posts/${newId}`)
);
router.post('/:id(\\d+)/repost', ensureAuth, action((req) => posts.toggleRepost(req.user.id, Number(req.params.id))));
router.post('/:id(\\d+)/like', ensureAuth, action((req) => engagement.toggleLike(req.user.id, Number(req.params.id))));
router.post('/:id(\\d+)/bookmark', ensureAuth, action((req) => engagement.toggleBookmark(req.user.id, Number(req.params.id))));
router.post(
  '/:id(\\d+)/delete',
  ensureAuth,
  action((req) => posts.deletePost(req.user.id, Number(req.params.id)), () => '/posts')
);

module.exports = router;
