'use strict';
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const core = require('./src/core');
const router = require('./src/router');
const db = require('./src/db');

const app = express();
app.set('trust proxy', 1);

// ---------------------------------------------------------------
// CORS — must run BEFORE express.json, routes, and any auth middleware
// so preflight OPTIONS requests are answered first.
// ---------------------------------------------------------------
// Comma-separated exact origins, e.g. "https://my-app.vercel.app,http://localhost:3000".
const rawOrigins = (process.env.ALLOWED_ORIGINS || '').trim();
const allowAll = rawOrigins === '*' || rawOrigins === '';
const allowedOrigins = rawOrigins
  .split(',')
  .map(s => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

// Strict Vercel preview pattern: https://<project-prefix>-<hash>.vercel.app
// Set VERCEL_PROJECT_PREFIX to your project name (e.g. "soft-manager").
// The hash is [a-z0-9]+ (Vercel deployment ids); arbitrary subdomains are rejected.
const projectPrefix = (process.env.VERCEL_PROJECT_PREFIX || '').trim().toLowerCase();
let previewRegex = null;
if (projectPrefix) {
  const esc = projectPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  previewRegex = new RegExp('^https://' + esc + '-[a-z0-9]+\\.vercel\\.app$', 'i');
}

function isOriginAllowed(origin) {
  if (!origin) return true;                      // curl / Postman / server-to-server: no Origin header
  if (allowAll) return true;                     // ALLOWED_ORIGINS unset or "*"
  const clean = origin.replace(/\/+$/, '');
  if (allowedOrigins.includes(clean)) return true;         // exact match
  if (previewRegex && previewRegex.test(clean)) return true; // Vercel preview deployments
  return false;
}

app.use(cors({
  origin(origin, cb) {
    if (isOriginAllowed(origin)) return cb(null, true);
    return cb(null, false);                      // no CORS headers -> browser blocks it
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token'],
  maxAge: 600
}));
// Ensure preflight requests are answered for every route, before body parsing/auth.
app.options('*', cors({
  origin(origin, cb) { return cb(null, isOriginAllowed(origin)); },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token'],
  maxAge: 600
}));

app.use(express.json({ limit: '1mb' }));


// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// Rate limits: PIN guesses are heavily capped; general calls more generous.
const pinLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Too many attempts. Wait a minute and try again.' } });
const callLimiter = rateLimit({ windowMs: 60 * 1000, limit: 400, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Too many requests. Please slow down.' } });

const wrap = fn => async (req, res) => {
  try { res.json({ ok: true, result: await fn(req.body || {}, req) }); }
  catch (e) {
    const status = e && e.statusCode ? e.statusCode : 400;
    res.status(status).json({ ok: false, error: e.message || 'Something went wrong.' });
  }
};

app.get('/', (req, res) => res.type('text').send('API is running.'));
app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    // Non-secret mail config summary so misconfiguration is visible at a glance.
    const mail = require('./src/mailer').configSummary();
    res.json({ ok: true, mail });
  } catch (e) {
    res.status(503).json({ ok: false, error: 'database unavailable' });
  }
});
app.post('/api/session', pinLimiter, wrap(b => router.session(b)));
app.post('/api/check', pinLimiter, wrap(b => router.check(b)));

// Data calls require a valid password session (Authorization: Bearer <token>).
// The token resolves to the account's own business; the body `code` is ignored, so knowing
// a business code alone can no longer read or write its data.
app.post('/api/call', callLimiter, async (req, res) => {
  try {
    const auth = req.get('authorization') || '';
    const bearer = /^Bearer\s+(.+)$/i.exec(auth);
    if (!bearer) return res.status(401).json({ ok: false, error: 'Please log in.' });
    const sess = await require('./src/onboarding').sessionFor(bearer[1]);
    if (!sess) return res.status(401).json({ ok: false, error: 'Session expired. Please log in again.' });
    const body = req.body || {};
    const app = String(body.app || '').toLowerCase();
    // getDashboard is cross-app: it aggregates whatever apps the business has.
    if (body.fn === 'getDashboard') {
      const result = await core.call({ code: sess.code, app, fn: 'getDashboard', args: body.args });
      return res.json({ ok: true, result });
    }
    if (!app || !sess.apps.includes(app)) {
      return res.status(403).json({ ok: false, error: 'Your account does not include this app.' });
    }
    const result = await core.call({ code: sess.code, app, fn: body.fn, args: body.args });
    return res.json({ ok: true, result });
  } catch (e) {
    const status = e && e.statusCode ? e.statusCode : 400;
    return res.status(status).json({ ok: false, error: e.message || 'Something went wrong.' });
  }
});



// ---------------------------------------------------------------
// Onboarding: registration -> email verification -> login -> password recovery
// ---------------------------------------------------------------
const onboarding = require('./src/onboarding');
const onboardLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Too many attempts. Please wait and try again.' } });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Too many login attempts. Please wait and try again.' } });

app.post('/api/onboard/register', onboardLimiter, wrap(b => onboarding.register(b)));
app.post('/api/onboard/login', loginLimiter, wrap(b => onboarding.login(b)));
app.post('/api/onboard/reset/request', onboardLimiter, wrap(b => onboarding.requestPasswordReset(b)));
app.post('/api/onboard/reset/confirm', onboardLimiter, wrap(b => onboarding.resetPassword(b)));

// Verification link target. Sends the user back to the FRONTEND (APP_BASE_URL) with a status.
app.get('/api/onboard/verify', async (req, res) => {
  const frontend = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  try {
    await onboarding.verifyEmail(req.query.token);
    if (frontend) return res.redirect(302, frontend + '/?verified=1');
    return res.type('text').send('Email verified. You can now log in from the app.');
  } catch (e) {
    const msg = (e && e.message) || 'Verification failed.';
    console.error('[onboard] verify FAILED: ' + msg);
    const code = /already been used|invalid/i.test(msg) ? 'used'
      : /expired/i.test(msg) ? 'expired'
      : 'error';
    if (frontend) return res.redirect(302, frontend + '/?verified=0&reason=' + code);
    return res.status(400).type('text').send(msg);
  }
});

// One-time setup of a new Services business (needs ADMIN_TOKEN)
app.post('/admin/setup', pinLimiter, async (req, res) => {
  const token = process.env.ADMIN_TOKEN;
  if (!token || req.get('x-admin-token') !== token) return res.status(401).json({ ok: false, error: 'Not allowed.' });
  try {
    const { code, name } = req.body || {};
    if (!code) throw new Error('Business code is required.');
    const result = await require('./src/setup').setupServices(code, name);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || 'Setup failed.' });
  }
});

// Diagnostic: send a test email and report the provider's exact response (needs ADMIN_TOKEN).
// Usage: curl -X POST .../admin/test-email -H "x-admin-token: ..." -H "Content-Type: application/json" -d '{"to":"you@example.com"}'
app.post('/admin/test-email', async (req, res) => {
  const token = process.env.ADMIN_TOKEN;
  if (!token || req.get('x-admin-token') !== token) return res.status(401).json({ ok: false, error: 'Not allowed.' });
  const mailer = require('./src/mailer');
  const to = (req.body && req.body.to) || '';
  const summary = mailer.configSummary();
  try {
    const out = await mailer.sendTest(to);
    res.json({ ok: true, summary, result: out });
  } catch (e) {
    res.status(400).json({ ok: false, summary, error: e.message });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log('API listening on ' + port);
  const s = require('./src/mailer').configSummary();
  if (!s.hasApiKey) console.warn('[mail] RESEND_API_KEY is NOT set — emails will only be logged, not sent.');
  if (s.isSandboxSender) console.warn('[mail] MAIL_FROM uses ' + s.from + ' (sandbox). Resend only delivers to your own Resend account email until you verify a domain.');
  if (!s.appBaseUrl) console.warn('[mail] APP_BASE_URL is NOT set — verification links will be relative and unusable in emails.');
});

// Graceful shutdown
process.on('SIGTERM', async () => { await db.close(); process.exit(0); });
process.on('SIGINT', async () => { await db.close(); process.exit(0); });
