// If your profile pages live elsewhere, change this one line.
const PROFILE_PATH = '/users/';

const HASHTAG = /(^|\s)#([\p{L}\p{N}_]{1,50})/gu;
const MENTION = /(^|\s)@([A-Za-z0-9_]{1,30})/g;

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function linkify(text) {
  if (!text) return '';
  return escapeHtml(text)
    .replace(HASHTAG, (_m, pre, tag) => `${pre}<a href="/tags/${encodeURIComponent(tag.toLowerCase())}">#${tag}</a>`)
    .replace(MENTION, (_m, pre, name) => `${pre}<a href="${PROFILE_PATH}${name}">@${name}</a>`);
}

module.exports = { linkify, escapeHtml, HASHTAG, MENTION, PROFILE_PATH };
