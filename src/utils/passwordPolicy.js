const { isValidPassword } = require('./validators');

const MIN_LENGTH = 8;
const MAX_BYTES = 72; // bcrypt ignores everything after 72 bytes

// Lowercase. A password is rejected if it, or it without trailing digits and symbols, is in this list.
const COMMON = new Set([
  'password', 'password1', 'password12', 'password123', 'passw0rd', 'p@ssw0rd', 'p@ssword', 'passpass', 'pass1234',
  'mypassword', 'mypass123', '123456', '1234567', '12345678', '123456789', '1234567890', '0123456789', '12341234',
  '11111111', '00000000', '123123123', '12345', '1234', '111111', '000000', '123123', '654321', '666666', '121212',
  '112233', '987654321', '987654', 'qwerty', 'qwerty123', 'qwertyuiop', 'qwertyui', 'qwerty12', 'qwer1234',
  'qweasdzxc', '1qaz2wsx', '1q2w3e4r', '1q2w3e4r5t', 'qazwsx', 'qazwsxedc', 'zaq12wsx', 'zxcvbnm', 'zxcvbnm1',
  'asdfghjk', 'asdfghjkl', 'asdfgh', 'abc123', 'abcd1234', 'abcdefgh', 'abcdefg1', 'abc12345', 'letmein',
  'welcome', 'welcome1', 'welcome123', 'admin', 'admin123', 'administrator', 'root', 'toor', 'login', 'master',
  'monkey', 'dragon', 'football', 'baseball', 'basketball', 'soccer', 'hockey', 'iloveyou', 'iloveyou1',
  'sunshine', 'princess', 'superman', 'batman', 'trustno1', 'shadow', 'michael', 'jennifer', 'jordan', 'hunter',
  'hunter2', 'ranger', 'buster', 'thomas', 'tigger', 'charlie', 'daniel', 'ashley', 'jessica', 'george', 'harley',
  'pepper', 'summer', 'winter', 'spring', 'secret', 'changeme', 'default', 'guest', 'test', 'test123', 'testing',
  'user', 'google', 'facebook', 'whatsapp', 'kenya', 'nairobi', 'mombasa', 'harambee', 'jambo', 'karibu', 'asante',
  'global', 'village', 'globalvillage',
]);

// The full policy applies everywhere except the test suite, where the earlier 6-72 character rule stays in
// force unless TEST_PASSWORD_POLICY is set. That keeps the many tests that register throwaway accounts with
// simple passwords working, while dedicated tests exercise the real policy.
const enforced = () => process.env.NODE_ENV !== 'test' || Boolean(process.env.TEST_PASSWORD_POLICY);

const stripTail = (password) => password.toLowerCase().replace(/[0-9!@#$%^&*._-]+$/, '');

// Every problem with a password, as messages safe to show to the person. Empty means acceptable.
function problems(password, identity) {
  if (typeof password !== 'string') return [`Password must be ${MIN_LENGTH}-${MAX_BYTES} characters.`];
  if (password.length < MIN_LENGTH) return [`Password must be at least ${MIN_LENGTH} characters.`];
  if (Buffer.byteLength(password, 'utf8') > MAX_BYTES) {
    return ['Password is too long (72 bytes at most; some characters count as more than one).'];
  }

  const found = [];
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || COMMON.has(stripTail(password))) {
    found.push('That password is too common. Choose something less guessable.');
  }
  if (new Set(password).size < 4) found.push('Password needs at least 4 different characters.');

  const { username, email } = identity || {};
  const names = [String(username || ''), String(email || '').split('@')[0], String(email || '')]
    .map((s) => s.toLowerCase())
    .filter((s) => s.length >= 4);
  if (names.some((name) => lower.includes(name))) found.push('Password cannot contain your username or email.');

  return found;
}

function validate(password, identity) {
  if (enforced()) return problems(password, identity);
  return isValidPassword(password) ? [] : ['Password must be 6-72 characters.'];
}

module.exports = { validate, problems, MIN_LENGTH, MAX_BYTES };
