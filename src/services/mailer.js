// Which transport is used is decided by environment variables, so switching needs no code change:
//   MAIL_TRANSPORT=log      (default) prints each email to the server log. Nothing is delivered.
//   MAIL_TRANSPORT=resend   RESEND_API_KEY and MAIL_FROM are required
//   MAIL_TRANSPORT=smtp     SMTP_URL and MAIL_FROM are required, and the nodemailer package must be installed
// The test suite collects emails in `outbox` instead, unless TEST_MAIL_TRANSPORT is set.
const outbox = [];
let warnedAboutLog = false;

const transportName = () => (process.env.MAIL_TRANSPORT || 'log').trim().toLowerCase();

function requireFrom() {
  if (!process.env.MAIL_FROM) throw new Error('MAIL_FROM is not set');
  return process.env.MAIL_FROM;
}

async function sendResend({ to, subject, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not set');
  const from = requireFrom();

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Resend responded with status ${response.status}`);
}

async function sendSmtp({ to, subject, text }) {
  if (!process.env.SMTP_URL) throw new Error('SMTP_URL is not set');
  const from = requireFrom();

  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (err) {
    throw new Error('MAIL_TRANSPORT=smtp needs the nodemailer package (run: npm install nodemailer)');
  }
  await nodemailer.createTransport(process.env.SMTP_URL).sendMail({ from, to, subject, text });
}

function sendLog({ to, subject, text }) {
  if (!warnedAboutLog && (process.env.NODE_ENV === 'production' || process.env.RENDER)) {
    warnedAboutLog = true;
    console.warn(
      "[mail] MAIL_TRANSPORT is 'log', so emails (including password reset links) are printed here and not delivered. " +
        'Set MAIL_TRANSPORT=resend (or smtp) to send real email.'
    );
  }
  console.log(`[mail] To: ${to}\n[mail] Subject: ${subject}\n${text}`);
}

// Resolves when the message was handed over. Rejects if the transport failed, so callers decide how to react.
async function send({ to, subject, text }) {
  if (process.env.NODE_ENV === 'test' && !process.env.TEST_MAIL_TRANSPORT) {
    outbox.push({ to, subject, text });
    return;
  }

  const name = transportName();
  if (name === 'resend') return sendResend({ to, subject, text });
  if (name === 'smtp') return sendSmtp({ to, subject, text });
  if (name === 'log') return sendLog({ to, subject, text });
  throw new Error(`Unknown MAIL_TRANSPORT "${name}" (use log, resend or smtp)`);
}

module.exports = { send, outbox, clearOutbox: () => { outbox.length = 0; } };
