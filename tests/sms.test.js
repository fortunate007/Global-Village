const sms = require('../src/services/sms');

const KEYS = [
  'TEST_SMS_TRANSPORT', 'SMS_TRANSPORT', 'AT_USERNAME', 'AT_API_KEY', 'AT_SANDBOX', 'AT_SENDER_ID',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM',
];
const saved = {};
const message = { to: '+254712345678', text: 'Your code is 123456' };

beforeEach(() => {
  KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  sms.clearOutbox();
});
afterEach(() => {
  KEYS.forEach((k) => {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  });
  delete global.fetch;
  jest.restoreAllMocks();
});

const accepted = (statusCode = 101, status = 'Success') => ({
  ok: true,
  status: 201,
  json: async () => ({ SMSMessageData: { Recipients: [{ statusCode, status }] } }),
});

test('while testing, messages are collected and nothing is sent', async () => {
  await sms.send(message);
  expect(sms.outbox).toEqual([message]);
  sms.clearOutbox();
  expect(sms.outbox).toEqual([]);
});

describe('real transports (switched on for these tests)', () => {
  beforeEach(() => { process.env.TEST_SMS_TRANSPORT = '1'; });

  test('log is the default and prints the message', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await sms.send(message);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('To: +254712345678'));
    expect(log.mock.calls[0][0]).toContain('Your code is 123456');
    expect(sms.outbox).toEqual([]);
  });

  test('an unknown transport is refused', async () => {
    process.env.SMS_TRANSPORT = 'carrier-pigeon';
    await expect(sms.send(message)).rejects.toThrow(/Unknown SMS_TRANSPORT/);
  });

  describe("Africa's Talking", () => {
    beforeEach(() => {
      process.env.SMS_TRANSPORT = 'AfricasTalking';
      process.env.AT_USERNAME = 'myapp';
      process.env.AT_API_KEY = 'at_test_key';
    });

    test('posts the message with the key, to the live address', async () => {
      global.fetch = jest.fn().mockResolvedValue(accepted());
      await sms.send(message);

      const [url, options] = global.fetch.mock.calls[0];
      expect(url).toBe('https://api.africastalking.com/version1/messaging');
      expect(options.method).toBe('POST');
      expect(options.headers.apiKey).toBe('at_test_key');
      expect(options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      const body = new URLSearchParams(options.body);
      expect(body.get('username')).toBe('myapp');
      expect(body.get('to')).toBe('+254712345678');
      expect(body.get('message')).toBe('Your code is 123456');
      expect(body.has('from')).toBe(false);
    });

    test('uses the sandbox address and the sender id when they are set', async () => {
      process.env.AT_SANDBOX = '1';
      process.env.AT_SENDER_ID = 'GlobalVillage';
      global.fetch = jest.fn().mockResolvedValue(accepted(102, 'Queued'));
      await sms.send(message);

      const [url, options] = global.fetch.mock.calls[0];
      expect(url).toBe('https://api.sandbox.africastalking.com/version1/messaging');
      expect(new URLSearchParams(options.body).get('from')).toBe('GlobalVillage');
    });

    test('failures and rejected recipients are reported', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 });
      await expect(sms.send(message)).rejects.toThrow(/status 401/);

      global.fetch = jest.fn().mockResolvedValue(accepted(403, 'InvalidPhoneNumber'));
      await expect(sms.send(message)).rejects.toThrow(/InvalidPhoneNumber/);

      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({}) });
      await expect(sms.send(message)).rejects.toThrow(/no recipient/);
    });

    test('missing settings are reported before anything is sent', async () => {
      global.fetch = jest.fn();
      delete process.env.AT_API_KEY;
      await expect(sms.send(message)).rejects.toThrow(/AT_API_KEY/);
      delete process.env.AT_USERNAME;
      await expect(sms.send(message)).rejects.toThrow(/AT_USERNAME/);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('Twilio', () => {
    beforeEach(() => {
      process.env.SMS_TRANSPORT = 'twilio';
      process.env.TWILIO_ACCOUNT_SID = 'AC123';
      process.env.TWILIO_AUTH_TOKEN = 'secret-token';
      process.env.TWILIO_FROM = '+15005550006';
    });

    test('posts the message with basic authentication', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 201 });
      await sms.send(message);

      const [url, options] = global.fetch.mock.calls[0];
      expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
      expect(options.headers.Authorization).toBe(`Basic ${Buffer.from('AC123:secret-token').toString('base64')}`);
      const body = new URLSearchParams(options.body);
      expect(body.get('To')).toBe('+254712345678');
      expect(body.get('From')).toBe('+15005550006');
      expect(body.get('Body')).toBe('Your code is 123456');
    });

    test('failures and missing settings are reported', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400 });
      await expect(sms.send(message)).rejects.toThrow(/status 400/);

      global.fetch = jest.fn();
      delete process.env.TWILIO_FROM;
      await expect(sms.send(message)).rejects.toThrow(/TWILIO_FROM/);
      delete process.env.TWILIO_AUTH_TOKEN;
      await expect(sms.send(message)).rejects.toThrow(/TWILIO_AUTH_TOKEN/);
      delete process.env.TWILIO_ACCOUNT_SID;
      await expect(sms.send(message)).rejects.toThrow(/TWILIO_ACCOUNT_SID/);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
