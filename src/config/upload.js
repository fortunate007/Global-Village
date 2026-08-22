const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

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
  const allowed = /jpeg|jpg|png|gif|webp/;
  const extOk = allowed.test(path.extname(file.originalname).toLowerCase());
  const mimeOk = allowed.test(file.mimetype);
  if (extOk && mimeOk) return cb(null, true);
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

module.exports = { avatarUpload, chatImageUpload };
