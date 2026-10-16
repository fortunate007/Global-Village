// Links in emails are built from a configured address, never from the request's Host header,
// otherwise an attacker could make the app email a victim a link that points at the attacker's site.
function baseUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.trim().replace(/\/+$/, '');
  if (process.env.NODE_ENV === 'production' || process.env.RENDER) return null;
  return `http://localhost:${process.env.PORT || 3000}`;
}

module.exports = { baseUrl };
