const { parsePhoneNumberFromString, getCountries, getCountryCallingCode } = require('libphonenumber-js');

const COUNTRIES = new Set(getCountries());

let regionNames = null;
try {
  regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
} catch (err) {
  regionNames = null;
}

function nameOf(code) {
  try {
    return (regionNames && regionNames.of(code)) || code;
  } catch (err) {
    return code;
  }
}

// The country whose rules read a number typed without a country code, when nobody chose a country
function defaultCountry() {
  const code = String(process.env.DEFAULT_PHONE_COUNTRY || 'KE').trim().toUpperCase();
  return COUNTRIES.has(code) ? code : 'KE';
}

// Optional allow-list of calling codes, to stop texts to expensive countries: PHONE_ALLOWED_COUNTRY_CODES=254,256
function allowedDialCodes() {
  return (process.env.PHONE_ALLOWED_COUNTRY_CODES || '')
    .split(',')
    .map((code) => code.replace(/\D/g, ''))
    .filter(Boolean);
}

// Every country with its calling code, sorted by name, for the dropdown on the forms
function countryList() {
  const allowed = allowedDialCodes();
  return [...COUNTRIES]
    .map((code) => ({ code, name: nameOf(code), dial: getCountryCallingCode(code) }))
    .filter((c) => allowed.length === 0 || allowed.some((a) => `+${c.dial}`.startsWith(`+${a}`)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Turns what a person typed into +<country code><number>, or returns null.
//  - A number starting with + (or 00) is read as written, whatever country is selected.
//  - Any other number is read in the selected country, the way people dial it there.
//  - With no country selected, the default country is used. A country that does not exist gives null.
// The number must be valid for its country. Valid does not guarantee reachable: the code that is sent is the proof.
function normalizePhone(input, country) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text || text.length > 30 || !/^[+\d\s().-]+$/.test(text)) return null;

  // 00 is how many countries dial internationally; it means the same as +
  const international = text.startsWith('00') ? `+${text.slice(2)}` : text;
  const hasPlus = international.startsWith('+');

  let region;
  if (!hasPlus) {
    if (typeof country === 'string' && country.trim()) {
      region = country.trim().toUpperCase();
      if (!COUNTRIES.has(region)) return null;
    } else {
      region = defaultCountry();
    }
  }

  let parsed;
  try {
    parsed = parsePhoneNumberFromString(international, region);
  } catch (err) {
    return null;
  }
  return parsed && parsed.isValid() ? parsed.number : null;
}

module.exports = { normalizePhone, countryList, defaultCountry };
