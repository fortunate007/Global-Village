const express = require('express');
const fs = require('fs');
const db = require('../db');
const posts = require('../services/postService');
const safety = require('../services/safetyService');
const postImages = require('../services/postImageService');
const imageFiles = require('../utils/imageFiles');
const { postImageUpload, MAX_FILES, MAX_BYTES } = require('../config/postUpload');
const { createLimiter } = require('../middleware/security');

const router = express.Router();

const skip = () => process.env.NODE_ENV === 'test' && !process.env.TEST_RATE_LIMITS;
const uploadLimit = createLimiter({ windowMs: 10 * 60 * 1000, limit: 30, skip });

const ensureAuth = (req, res, next) => (req.isAuthenticated() ? next() : res.redirect('/login'));

// Only forms that can carry pictures are handled here. Plain forms continue to the existing routes.
const multipart = (req, res, next) => (req.is('multipart/form-data') ? next() : next('route'));

function uploadMessage(err) {
  if (err && err.code === 'LIMIT_FILE_SIZE') return `Each picture must be ${MAX_BYTES / 1024 / 1024} MB or smaller.`;
  if (err && (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT')) return `You can attach up to ${MAX_FILES} pictures.`;
  if (err && /Only image files/.test(err.message || '')) return err.message;
  return 'Could not read the upload. Please try again.';
}

function receive(req, res, next) {
  postImageUpload(req, res, (err) => {
    if (!err) return next();
    req.flash('error', uploadMessage(err));
    return res.redirect('back');
  });
}

// Checks the uploaded files, then creates the post or reply with its pictures. Files of a failed request are deleted.
function finish(parentOf) {
  return (req, res, next) => {
    const files = req.files || [];
    const discard = () => files.forEach((file) => fs.unlink(file.path, () => {}));
    const parentId = parentOf(req);

    try {
      const alts = [].concat(req.body.alt === undefined ? [] : req.body.alt);
      const prepared = files.map((file, index) => ({
        ...imageFiles.cleanUploadedImage(file.path, file.filename),
        filename: file.filename,
        alt: alts[index],
      }));
      postImages.createPostWithImages({ authorId: req.user.id, body: req.body.body, parentId, images: prepared });
      return res.redirect(parentId ? `/posts/${parentId}` : '/posts');
    } catch (err) {
      discard();
      if (err instanceof imageFiles.ImageError || err instanceof posts.PostError) {
        req.flash('error', err.message);
        return res.redirect('back');
      }
      if (safety.isBlockError(err)) {
        req.flash('error', "You can't interact with that account.");
        return res.redirect('back');
      }
      return next(err);
    }
  };
}

router.post('/', ensureAuth, multipart, uploadLimit, receive, finish(() => null));
router.post('/:id(\\d+)/reply', ensureAuth, multipart, uploadLimit, receive, finish((req) => Number(req.params.id)));

// When an author deletes a post, its pictures (and those of its replies) are deleted too, once the post is really gone.
// The existing delete route does the deleting; this only looks after the files.
router.post('/:id(\\d+)/delete', ensureAuth, (req, res, next) => {
  const postId = Number(req.params.id);
  const files = postImages.deletableFilenames(postId, req.user.id);
  if (files.length) {
    res.once('finish', () => {
      if (!db.prepare('SELECT 1 FROM posts WHERE id = ?').get(postId)) postImages.removeFiles(files);
    });
  }
  next();
});

module.exports = router;
