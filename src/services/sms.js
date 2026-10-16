// Which transport is used is decided by environment variables, so switching needs no code change:
//   SMS_TRANSPORT=log             (default) prints each message to the server log. Nothing is delivered.
//   SMS_TRANSPORT=africastalking  AT_USERNAME and AT_API_KEY are required. Optional: AT_SENDER_ID, AT_SANDBOX=1
//   SMS_TRANSPORT=twilio          TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM are required
// The test suite collects messages in `outbox` instead, unless TEST_SMS_TRANSPORT is set.
const outbox = [];
let warnedAboutLog = false;

const transportName = () => (process.env.SMS_TRANSPORT || 'log').trim().toLowerCase();
const isOn = (value) => ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());

async function sendAfricasTalking({ to, text }) {
  const username = process.env.AT_USERNAME;
  const apiKey = process.env.AT_API_KEY;
  if (!username) throw new Error('AT_USERNAME is not set');
  if (!apiKey) throw new Error('AT_API_KEY is not set');

  const url = isOn(process.env.AT_SANDBOX)
    ? 'https://api.sandbox.africastalking.com/version1/messaging'
    : 'https://api.africastalking.com/version1/messaging';
  const body = new URLSearchParams({ username, to, message: text });
  if (process.env.AT_SENDER_ID) body.set('from', process.env.AT_SENDER_ID);

  const response = await fetch(url, {
    method: 'POST',
    headers: { apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Africa's Talking responded with status ${response.status}`);

  const data = await response.json();
  const recipients = data && data.SMSMessageData && data.SMSMessageData.Recipients;
  const recipient = recipients && recipients[0];
  // 100 = processed, 101 = sent, 102 = queued
  if (!recipient || ![100, 101, 102].includes(Number(recipient.statusCode))) {
    throw new Error(`Africa's Talking did not accept the message (${recipient ? recipient.status : 'no recipient'})`);
  }
}

async function sendTwilio({ to, text }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!sid) throw new Error('TWILIO_ACCOUNT_SID is not set');
  if (!token) throw new Error('TWILIO_AUTH_TOKEN is not set');
  if (!from) throw new Error('TWILIO_FROM is not set');

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: from, Body: text }).toString(),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Twilio responded with status ${response.status}`);
}

function sendLog({ to, text }) {
  if (!warnedAboutLog && (process.env.NODE_ENV === 'production' || process.env.RENDER)) {
    warnedAboutLog = true;
    console.warn(
      "[sms] SMS_TRANSPORT is 'log', so text messages (including verification and reset codes) are printed here " +
        'and not delivered. Set SMS_TRANSPORT=africastalking (or twilio) to send real messages.'
    );
  }
  console.log(`[sms] To: ${to}\n[sms] ${text}`);
}

// Resolves when the message was handed over. Rejects if the transport failed, so callers decide how to react.
async function send({ to, text }) {
  if (process.env.NODE_ENV === 'test' && !process.env.TEST_SMS_TRANSPORT) {
    outbox.push({ to, text });
    return;
  }

  const name = transportName();
  if (name === 'africastalking') return sendAfricasTalking({ to, text });
  if (name === 'twilio') return sendTwilio({ to, text });
  if (name === 'log') return sendLog({ to, text });
  throw new Error(`Unknown SMS_TRANSPORT "${name}" (use log, africastalking or twilio)`);
}

module.exports = { send, outbox, clearOutbox: () => { outbox.length = 0; } };
