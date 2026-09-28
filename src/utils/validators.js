const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidUsername(value) {
  return typeof value === 'string' && USERNAME_RE.test(value);
}

function isValidEmail(value) {
  return typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value);
}

function isValidPassword(value) {
  return typeof value === 'string' && value.length >= 6 && value.length <= 72;
}

function isValidDisplayName(value) {
  const trimmed = (value || '').trim();
  return trimmed.length >= 1 && trimmed.length <= 40;
}

function withinLength(value, max) {
  return (value || '').length <= max;
}

module.exports = {
  isValidUsername,
  isValidEmail,
  isValidPassword,
  isValidDisplayName,
  withinLength,
};
