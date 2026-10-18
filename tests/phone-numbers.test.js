const { normalizePhone, countryList, defaultCountry } = require('../src/utils/phoneNumbers');

function withEnv(name, value, run) {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return run();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

describe('numbers from around the world', () => {
  test.each([
    ['Kenya', '0712 345 678', 'KE', '+254712345678'],
    ['Kenya without the leading 0', '712345678', 'KE', '+254712345678'],
    ['Uganda', '0712 345678', 'UG', '+256712345678'],
    ['Nigeria', '0802 123 4567', 'NG', '+2348021234567'],
    ['United States', '(213) 373-4253', 'US', '+12133734253'],
    ['United Kingdom', '020 8765 4321', 'GB', '+442087654321'],
    ['Germany', '0151 23456789', 'DE', '+4915123456789'],
    ['India', '081 2345 6789', 'IN', '+918123456789'],
    ['Brazil', '(11) 96123-4567', 'BR', '+5511961234567'],
  ])('%s: %s (%s)', (_name, input, country, expected) => {
    expect(normalizePhone(input, country)).toBe(expected);
  });

  test('a + number is read as written, whatever country is selected', () => {
    expect(normalizePhone('+44 20 8765 4321', 'KE')).toBe('+442087654321');
    expect(normalizePhone('0044 20 8765 4321', 'US')).toBe('+442087654321');
    expect(normalizePhone('+1 (213) 373-4253')).toBe('+12133734253');
  });

  test('any other number is read in the selected country only', () => {
    expect(normalizePhone('0712345678', 'ke')).toBe('+254712345678');
    expect(normalizePhone('0712345678', 'US')).toBeNull();
    expect(normalizePhone('0712345678', 'ZZ')).toBeNull();
  });

  test('junk and impossible numbers are refused', () => {
    ['', '   ', 'abc', '12345', '+1234', '+0123456789', '+999999999', 'x'.repeat(40), '0712 345 678 ext 5'].forEach((value) => {
      expect(normalizePhone(value, 'KE')).toBeNull();
    });
    [undefined, null, 712345678, ['0712345678'], {}].forEach((value) => expect(normalizePhone(value, 'KE')).toBeNull());
  });

  test('the numbers other tests make up are valid Kenyan mobile numbers', () => {
    [1, 2, 3, 50, 999, 99999].forEach((n) => {
      [10000000, 20000000].forEach((base) => {
        const local = `07${String(base + n)}`;
        expect(normalizePhone(local, 'KE')).toBe(`+254${local.slice(1)}`);
      });
    });
  });
});

describe('the default country', () => {
  test('is Kenya unless configured, and a bad setting falls back to Kenya', () => {
    withEnv('DEFAULT_PHONE_COUNTRY', undefined, () => expect(defaultCountry()).toBe('KE'));
    withEnv('DEFAULT_PHONE_COUNTRY', 'ug', () => expect(defaultCountry()).toBe('UG'));
    withEnv('DEFAULT_PHONE_COUNTRY', 'ZZ', () => expect(defaultCountry()).toBe('KE'));
  });

  test('reads numbers typed with no country selected', () => {
    withEnv('DEFAULT_PHONE_COUNTRY', undefined, () => expect(normalizePhone('0712345678')).toBe('+254712345678'));
    withEnv('DEFAULT_PHONE_COUNTRY', 'UG', () => expect(normalizePhone('0712345678')).toBe('+256712345678'));
  });
});

describe('the country list', () => {
  test('covers the world, sorted by name, with calling codes', () => {
    const list = countryList();
    expect(list.length).toBeGreaterThan(200);
    expect(list.find((c) => c.code === 'KE')).toEqual({ code: 'KE', name: 'Kenya', dial: '254' });
    expect(list.find((c) => c.code === 'US')).toMatchObject({ name: 'United States', dial: '1' });
    expect(list.find((c) => c.code === 'JP').dial).toBe('81');

    const names = list.map((c) => c.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  test('the allowed-countries setting shortens it', () => {
    withEnv('PHONE_ALLOWED_COUNTRY_CODES', '254, 256', () => {
      expect(countryList().map((c) => c.code).sort()).toEqual(['KE', 'UG']);
    });
    expect(countryList().length).toBeGreaterThan(200);
  });
});
