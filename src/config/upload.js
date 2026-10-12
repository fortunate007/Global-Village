const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

// Each allowed extension with the content types a browser may send for it
const ALLOWED_TYPES = {
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.png': ['image/png'],
  '.gif': ['image/gif'],
  '.webp': ['image/webp'],
};

function makeStorage(subdir) {
  return multer.diskStorage({
    destination: path.join(__dirname, '..', '..', 'src', 'public', 'uploads', subdir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const name = crypto.randomBytes(16).toString('hex') + ext;
      cb(null, name);
    },
  });
}

const imageFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const types = Object.prototype.hasOwnProperty.call(ALLOWED_TYPES, ext) ? ALLOWED_TYPES[ext] : null;
  if (types && types.includes(file.mimetype)) return cb(null, true);
  cb(new Error('Only image files (jpg, png, gif, webp) are allowed.'));
};

const avatarUpload = multer({
  storage: makeStorage('avatars'),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: imageFilter,
});

const chatImageUpload = multer({
  storage: makeStorage('chat'),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: imageFilter,
});

module.exports = { avatarUpload, chatImageUpload, imageFilter };
