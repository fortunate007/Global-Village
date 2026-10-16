const mockSendMail = jest.fn().mockResolvedValue({});
const mockCreateTransport = jest.fn(() => ({ sendMail: mockSendMail }));
jest.mock('nodemailer', () => ({ createTransport: (...args) => mockCreateTransport(...args) }), { virtual: true });

const mailer = require('../src/services/mailer');

const KEYS = ['TEST_MAIL_TRANSPORT', 'MAIL_TRANSPORT', 'RESEND_API_KEY', 'SMTP_URL', 'MAIL_FROM'];
const saved = {};
const message = { to: 'person@example.com', subject: 'Hello', text: 'Body text' };

beforeEach(() => {
  KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  mailer.clearOutbox();
  mockSendMail.mockClear();
  mockCreateTransport.mockClear();
});
afterEach(() => {
  KEYS.forEach((k) => {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  });
  delete global.fetch;
  jest.restoreAllMocks();
});

test('while testing, emails are collected and nothing is sent', async () => {
  await mailer.send(message);
  expect(mailer.outbox).toEqual([message]);
  mailer.clearOutbox();
  expect(mailer.outbox).toEqual([]);
});

describe('real transports (switched on for these tests)', () => {
  beforeEach(() => { process.env.TEST_MAIL_TRANSPORT = '1'; });

  test('log is the default and prints the email', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await mailer.send(message);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('To: person@example.com'));
    expect(log.mock.calls[0][0]).toContain('Body text');
    expect(mailer.outbox).toEqual([]);
  });

  test('an unknown transport is refused', async () => {
    process.env.MAIL_TRANSPORT = 'carrier-pigeon';
    await expect(mailer.send(message)).rejects.toThrow(/Unknown MAIL_TRANSPORT/);
  });

  test('resend posts to the Resend API with the key and addresses', async () => {
    process.env.MAIL_TRANSPORT = 'Resend';
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.MAIL_FROM = 'Global Village <hello@example.com>';
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    await mailer.send(message);

    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe('Bearer re_test_key');
    expect(JSON.parse(options.body)).toEqual({
      from: 'Global Village <hello@example.com>',
      to: ['person@example.com'],
      subject: 'Hello',
      text: 'Body text',
    });
  });

  test('resend failures and missing settings are reported', async () => {
    process.env.MAIL_TRANSPORT = 'resend';
    await expect(mailer.send(message)).rejects.toThrow(/RESEND_API_KEY/);

    process.env.RESEND_API_KEY = 're_test_key';
    await expect(mailer.send(message)).rejects.toThrow(/MAIL_FROM/);

    process.env.MAIL_FROM = 'hello@example.com';
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403 });
    await expect(mailer.send(message)).rejects.toThrow(/status 403/);
  });

  test('smtp hands the message to nodemailer', async () => {
    process.env.MAIL_TRANSPORT = 'smtp';
    process.env.SMTP_URL = 'smtp://user:pass@mail.example.com:587';
    process.env.MAIL_FROM = 'hello@example.com';

    await mailer.send(message);

    expect(mockCreateTransport).toHaveBeenCalledWith('smtp://user:pass@mail.example.com:587');
    expect(mockSendMail).toHaveBeenCalledWith({
      from: 'hello@example.com',
      to: 'person@example.com',
      subject: 'Hello',
      text: 'Body text',
    });
  });

  test('smtp needs its settings', async () => {
    process.env.MAIL_TRANSPORT = 'smtp';
    await expect(mailer.send(message)).rejects.toThrow(/SMTP_URL/);
    process.env.SMTP_URL = 'smtp://mail.example.com';
    await expect(mailer.send(message)).rejects.toThrow(/MAIL_FROM/);
  });
});
