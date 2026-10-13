const { problems, validate } = require('../src/utils/passwordPolicy');

const messages = (password, identity) => problems(password, identity).join(' | ');
const wide = (n) => Array.from({ length: n }, (_, i) => String.fromCharCode(0x4e00 + i)).join('');

describe('length', () => {
  test('needs at least 8 characters', () => {
    expect(messages('Zq7!pLm')).toMatch(/at least 8 characters/);
    expect(problems('Zq7!pLm2')).toEqual([]);
  });

  test('allows at most 72 bytes, counting multi-byte characters', () => {
    expect(problems('abcd'.repeat(18))).toEqual([]);
    expect(messages('abcd'.repeat(18) + 'e')).toMatch(/too long/);
    expect(problems(wide(24))).toEqual([]);
    expect(messages(wide(25))).toMatch(/too long/);
  });

  test('anything that is not text is refused', () => {
    [undefined, null, 12345678, ['abcdefgh'], {}].forEach((value) => {
      expect(problems(value)).toHaveLength(1);
      expect(messages(value)).toMatch(/8-72/);
    });
  });
});

describe('common and weak passwords', () => {
  test.each(['password', 'PASSWORD', 'Password123', 'qwerty2024!', 'Kenya2024', 'letmein99', 'GlobalVillage1'])(
    '%s is too common',
    (password) => expect(messages(password)).toMatch(/too common/)
  );

  test.each(['correct horse battery staple', 'T7-lemon-river-93', 'Zq7!pLm2', 'abcdabcd'])(
    '%s is accepted',
    (password) => expect(problems(password)).toEqual([])
  );

  test.each(['aaaaaaaa', 'abababab', 'abcabcabc'])('%s has too few different characters', (password) => {
    expect(messages(password)).toMatch(/different characters/);
  });
});

describe('the person\'s own details', () => {
  const identity = { username: 'newton', email: 'newtonk@example.com' };

  test('a password containing the username or the name part of the email is refused', () => {
    expect(messages('Newton-rocks-42', identity)).toMatch(/cannot contain your username or email/);
    expect(messages('xx-NEWTONK-xx9', identity)).toMatch(/cannot contain your username or email/);
    expect(messages('Qz-Vandelay-55', { username: 'jdoe_99', email: 'vandelay@example.com' })).toMatch(
      /cannot contain your username or email/
    );
    expect(messages('someone@example.com', { username: 'x', email: 'someone@example.com' })).toMatch(
      /cannot contain your username or email/
    );
  });

  test('very short names are not matched inside longer passwords, and missing details are fine', () => {
    expect(problems('Amy-and-Zeke-77', { username: 'amy' })).toEqual([]);
    expect(problems('Zq7!pLm2')).toEqual([]);
    expect(problems('Zq7!pLm2', null)).toEqual([]);
    expect(problems('Zq7!pLm2', {})).toEqual([]);
  });
});

describe('validate() and the test switch', () => {
  const savedSwitch = process.env.TEST_PASSWORD_POLICY;
  const savedEnv = process.env.NODE_ENV;
  afterEach(() => {
    if (savedSwitch === undefined) delete process.env.TEST_PASSWORD_POLICY;
    else process.env.TEST_PASSWORD_POLICY = savedSwitch;
    process.env.NODE_ENV = savedEnv;
  });

  test('without the switch, the test suite keeps the earlier 6-72 character rule', () => {
    delete process.env.TEST_PASSWORD_POLICY;
    expect(validate('secret')).toEqual([]);
    expect(validate('abc')).toEqual(['Password must be 6-72 characters.']);
  });

  test('with the switch, the full policy applies', () => {
    process.env.TEST_PASSWORD_POLICY = '1';
    expect(messages('secret')).toMatch(/at least 8/);
    expect(validate('secret').join(' ')).toMatch(/at least 8/);
    expect(validate('Zq7!pLm2')).toEqual([]);
  });

  test('outside the test suite the full policy always applies', () => {
    delete process.env.TEST_PASSWORD_POLICY;
    process.env.NODE_ENV = 'production';
    expect(validate('secret').join(' ')).toMatch(/at least 8/);
    expect(validate('password123').join(' ')).toMatch(/too common/);
  });
});
