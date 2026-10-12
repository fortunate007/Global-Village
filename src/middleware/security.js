const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function deny(res) {
  res.status(403).type('text/plain').send('Blocked: this request did not come from this site.');
}

// CSRF defence using headers that browsers add themselves and web pages cannot forge.
//  - Sec-Fetch-Site: sent by all modern browsers; only same-origin (or user-typed) writes pass.
//  - Origin: fallback for browsers without Sec-Fetch-Site; must match this site's host.
//  - Neither header: not a browser request (curl, tests, server-to-server), so CSRF cannot apply.
function sameOrigin() {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();

    const site = req.get('sec-fetch-site');
    if (site) return site === 'same-origin' || site === 'none' ? next() : deny(res);

    const origin = req.get('origin');
    if (!origin) return next();
    try {
      if (new URL(origin).host === req.get('host')) return next();
    } catch (err) {
      // malformed or "null" origin: treated as foreign
    }
    return deny(res);
  };
}

function createLimiter(options) {
  return rateLimit({
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).type('text/plain').send('Too many attempts. Please wait a few minutes and try again.');
    },
    ...options,
  });
}

// Runs first: proxy trust and security headers (also applied to static files)
function applyEarly(app) {
  // Behind a proxy (Render), set TRUST_PROXY=1 so rate limits use each visitor's real IP
  if (process.env.TRUST_PROXY) {
    const hops = Number(process.env.TRUST_PROXY);
    app.set('trust proxy', Number.isInteger(hops) ? hops : process.env.TRUST_PROXY);
  }

  app.use(
    helmet({
      // 'same-origin' keeps res.redirect('back') working; the default (no-referrer) would break it
      referrerPolicy: { policy: 'same-origin' },
      // Report-only: the browser console lists violations, nothing is blocked yet
      contentSecurityPolicy: {
        reportOnly: true,
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", 'ws:', 'wss:'],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
    })
  );
}

// Runs after sessions and body parsing, before the routes
function applyLate(app) {
  app.use(sameOrigin());

  // Limits are switched off while running the test suite
  const skip = () => process.env.NODE_ENV === 'test';
  const limits = {
    login: createLimiter({ windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true, skip }),
    register: createLimiter({ windowMs: 60 * 60 * 1000, limit: 10, skip }),
    posting: createLimiter({ windowMs: 10 * 60 * 1000, limit: 60, skip }),
    reports: createLimiter({ windowMs: 60 * 60 * 1000, limit: 20, skip }),
    writes: createLimiter({ windowMs: 15 * 60 * 1000, limit: 600, skip }),
  };

  app.post('/login', limits.login);
  app.post('/register', limits.register);
  app.post(/^\/posts(\/.*)?$/, limits.posting);
  app.post('/safety/report/:id', limits.reports);
  app.use((req, res, next) => (SAFE_METHODS.has(req.method) ? next() : limits.writes(req, res, next)));
}

module.exports = { sameOrigin, createLimiter, applyEarly, applyLate };
