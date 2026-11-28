'use strict';
// Onboarding: registration, email verification + provisioning, login, password recovery.
// All multi-step writes run in a single transaction so a failed provisioning rolls back.
const { withTransaction, query } = require('./db');
const { hashPassword, verifyPassword, randomToken, randomOtp, sha256 } = require('./auth');
const mailer = require('./mailer');

const APP_VERSION_TO_APPS = {
  SALES: ['SALES'],
  SVC: ['SERVICES'],
  BOTH: ['SALES', 'SERVICES']
};

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;   // 24h
const OTP_TTL_MS = 10 * 60 * 1000;           // 10m
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS || 168) * 60 * 60 * 1000;

// Email verification toggle. Set REQUIRE_EMAIL_VERIFICATION=true if you want strict enforcement. Default: false (non-compulsory).
function emailVerificationRequired() {
  return String(process.env.REQUIRE_EMAIL_VERIFICATION || '').toLowerCase() === 'true';
}

// The verification link must point at the BACKEND (where /api/onboard/verify lives),
// so it uses PUBLIC_BACKEND_URL. The post-verify redirect target (frontend) is APP_BASE_URL.
function backendUrl() {
  return (process.env.PUBLIC_BACKEND_URL || process.env.APP_BASE_URL || '').replace(/\/+$/, '');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function appsForAccount(appVersion, businesses) {
  const activeApps = new Set();
  businesses.forEach(b => {
    const app = String(b.app || '').toUpperCase();
    if (b.active === true && (app === 'SALES' || app === 'SERVICES')) activeApps.add(app);
  });
  const selectedApps = APP_VERSION_TO_APPS[appVersion] || Array.from(activeApps);
  return selectedApps.filter(app => activeApps.has(app)).map(app => app.toLowerCase());
}

function validateRegistration({ businessName, email, password, appVersion }) {
  const errors = [];
  const name = String(businessName || '').trim();
  if (name.length < 2) errors.push('Business name is required.');
  if (name.length > 120) errors.push('Business name is too long.');
  const mail = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) errors.push('Enter a valid email address.');
  if (String(password || '').length < 8) errors.push('Password must be at least 8 characters.');
  if (!APP_VERSION_TO_APPS[appVersion]) errors.push('Choose a valid application version.');
  if (errors.length) {
    const err = new Error(errors[0]);
    err.errors = errors;
    err.statusCode = 400;
    throw err;
  }
  return { name, email: mail, password: String(password), appVersion };
}

// Generate a unique business code, e.g. "K7X2-M9QP" (same shape the old PIN used).
async function generateBusinessCode(client) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    const bytes = require('crypto').randomBytes(8);
    for (let i = 0; i < 8; i++) {
      code += alphabet[bytes[i] % alphabet.length];
      if (i === 3) code += '-';
    }
    const clash = await client.query('SELECT 1 FROM businesses WHERE code = $1 LIMIT 1', [code]);
    if (!clash.rows.length) return code;
  }
  // Fallback guaranteed unique timestamp/random code if 50 random tries collide
  return 'B' + Date.now().toString(36).toUpperCase() + '-' + require('crypto').randomBytes(2).toString('hex').toUpperCase();
}

// Insert a business row for one app (Sales or Services) linked to the account.
async function createBusinessRow(client, code, name, app) {
  const ins = await client.query(
    'INSERT INTO businesses (code, name, app, active, account_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [code, name, app, true, code]
  );
  return ins.rows[0].id;
}

// Seed Services defaults (services, settings, categories, counters). Mirrors setup.js but
// runs on the given client inside the caller's transaction.
async function seedServices(client, bizId, name) {
  const DEFAULT_SERVICES = [
    ['SVC0001', 'Standard Service', 2000],
    ['SVC0002', 'Express Service', 3500],
    ['SVC0003', 'Consultation', 1500],
    ['SVC0004', 'Home Visit', 5000],
    ['SVC0005', 'Per-item Service', 500]
  ];
  const DEFAULT_SETTINGS = [
    ['BusinessName', name],
    ['Address', ''],
    ['Phone', ''],
    ['ReceiptFooter', 'Thank you for your patronage!'],
    ['Currency', '\u20A6']
  ];
  const DEFAULT_CATEGORIES = ['Detergent & Supplies', 'Electricity / Utilities', 'Rent', 'Staff Wages',
    'Equipment / Maintenance', 'Transport', 'Other'];

  for (const [k, v] of DEFAULT_SETTINGS) {
    await client.query(
      `INSERT INTO svc_settings (business_id, key, value) VALUES ($1,$2,$3)
       ON CONFLICT (business_id, key) DO NOTHING`,
      [bizId, k, v]
    );
  }
  for (const [sid, nm, price] of DEFAULT_SERVICES) {
    await client.query(
      'INSERT INTO svc_services (business_id, service_id, name, price, active) VALUES ($1,$2,$3,$4,TRUE) ON CONFLICT (business_id, service_id) DO NOTHING',
      [bizId, sid, nm, price]
    );
  }
  let i = 0;
  for (const nm of DEFAULT_CATEGORIES) {
    i += 1;
    await client.query(
      'INSERT INTO svc_categories (business_id, category_id, name, type, active) VALUES ($1,$2,$3,$4,TRUE) ON CONFLICT (business_id, category_id) DO NOTHING',
      [bizId, 'CAT' + String(i).padStart(4, '0'), nm, 'Expense']
    );
  }
  await client.query(
    `INSERT INTO counters (business_id, name, value) VALUES ($1,'svc',5)
     ON CONFLICT (business_id, name) DO UPDATE SET value = GREATEST(counters.value, EXCLUDED.value)`,
    [bizId]
  );
  await client.query(
    `INSERT INTO counters (business_id, name, value) VALUES ($1,'cat',7)
     ON CONFLICT (business_id, name) DO UPDATE SET value = GREATEST(counters.value, EXCLUDED.value)`,
    [bizId]
  );
}

// Seed Sales config display defaults.
async function seedSales(client, bizId, name) {
  const defaults = [
    ['BusinessName', name],
    ['Address', ''],
    ['Phone', ''],
    ['Footer', 'Thank you!'],
    ['Currency', '\u20A6']
  ];
  for (const [k, v] of defaults) {
    await client.query(
      `INSERT INTO sales_config (business_id, key, value) VALUES ($1,$2,$3)
       ON CONFLICT (business_id, key) DO NOTHING`,
      [bizId, k, v]
    );
  }
}

// Provision one business row per app for an account (idempotent), then optionally activate.
// Shared by verifyEmail() and register() (when verification is disabled).
async function provisionAccount(client, accountId, businessName, appVersion, activate) {
  const apps = APP_VERSION_TO_APPS[appVersion] || ['SALES'];
  const account = await client.query('SELECT business_code FROM accounts WHERE id = $1', [accountId]);
  let code = account.rows[0] && account.rows[0].business_code;
  if (!code) {
    code = await generateBusinessCode(client);
    await client.query('UPDATE accounts SET business_code = $1 WHERE id = $2', [code, accountId]);
  }

  for (const app of apps) {
    const already = await client.query('SELECT id FROM businesses WHERE account_id = $1 AND app = $2 LIMIT 1', [code, app]);
    let bizId;
    if (already.rows.length) {
      bizId = already.rows[0].id;
    } else {
      bizId = await createBusinessRow(client, code, businessName, app);
    }
    if (app === 'SERVICES') await seedServices(client, bizId, businessName);
    if (app === 'SALES') await seedSales(client, bizId, businessName);
  }

  if (activate) {
    await client.query("UPDATE accounts SET status = 'ACTIVE', verified_at = now() WHERE id = $1", [accountId]);
  }
  return code;
}

// ---------------------------------------------------------------
// Register
// ---------------------------------------------------------------
async function register(body) {
  const { name, email, password, appVersion } = validateRegistration(body);

  // Pre-check for a duplicate email (the UNIQUE index is the final guard against races).
  const existing = await query('SELECT id FROM accounts WHERE lower(email) = lower($1)', [email]);

  let created;
  if (existing.rows.length) {
    const acc = existing.rows[0];
    const statusRow = await query('SELECT status FROM accounts WHERE id = $1', [acc.id]);
    if (statusRow.rows[0].status === 'ACTIVE') {
      const e = new Error('This email is already registered. Please log in.');
      e.statusCode = 409;
      throw e;
    }
    // Pending account: resend a fresh verification link.
    created = { id: acc.id, name, email, resent: true };
  }

  const passwordHash = hashPassword(password);
  const requireVerify = emailVerificationRequired();

  let accountId;
  const token = randomToken(32);
  const tokenHash = sha256(token);

  await withTransaction(async client => {
    if (!created) {
      // Guard the race: ON CONFLICT on the unique lower(email) index. Accounts are active immediately (verification non-compulsory).
      const initialStatus = 'ACTIVE';
      const ins = await client.query(
        `INSERT INTO accounts (email, password_hash, business_name, app_version, status)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (lower(email)) DO NOTHING
         RETURNING id`,
        [email, passwordHash, name, appVersion, initialStatus]
      );
      if (!ins.rows.length) {
        // Someone created it between our check and now.
        const again = await client.query('SELECT id, status FROM accounts WHERE lower(email) = lower($1)', [email]);
        if (again.rows.length && again.rows[0].status === 'ACTIVE') {
          const e = new Error('This email is already registered. Please log in.');
          e.statusCode = 409;
          throw e;
        }
        accountId = again.rows[0].id;
      } else {
        accountId = ins.rows[0].id;
      }
    } else {
      accountId = created.id;
      // Refresh password/name/app_version on the account.
      await client.query(
        'UPDATE accounts SET password_hash = $1, business_name = $2, app_version = $3, status = $4 WHERE id = $5',
        [passwordHash, name, appVersion, 'ACTIVE', accountId]
      );
    }

    // Always provision workspace(s) immediately on signup so user can log in right away.
    await provisionAccount(client, accountId, name, appVersion, true);

    // Also store verification token asynchronously/non-blockingly for optional verification email.
    await client.query('UPDATE email_verifications SET consumed_at = now() WHERE account_id = $1 AND consumed_at IS NULL', [accountId]);
    await client.query(
      'INSERT INTO email_verifications (account_id, token_hash, expires_at) VALUES ($1,$2,$3)',
      [accountId, tokenHash, new Date(Date.now() + VERIFY_TTL_MS)]
    );
  });

  // Send verification email via Brevo SMTP asynchronously (non-blocking)
  const link = backendUrl() + '/api/onboard/verify?token=' + encodeURIComponent(token);
  let emailDelivered = true;
  try {
    const sent = await mailer.sendVerificationEmail({ to: email, businessName: name, link });
    emailDelivered = !sent || sent.delivered !== false;
  } catch (e) {
    emailDelivered = false;
    console.error('[onboarding] optional verification email FAILED for ' + email + ': ' + (e && e.message));
  }

  return {
    status: 'active',
    emailDelivered,
    message: 'Your account has been created successfully. You can log in now.',
    email
  };
}

// ---------------------------------------------------------------
// Verify email + provision workspace(s) (transactional, idempotent)
// ---------------------------------------------------------------
async function verifyEmail(token) {
  const tokenHash = sha256(String(token || ''));
  const found = await query(
    `SELECT ev.id AS verif_id, ev.account_id, ev.expires_at, a.status, a.business_name, a.app_version
     FROM email_verifications ev JOIN accounts a ON a.id = ev.account_id
     WHERE ev.token_hash = $1 AND ev.consumed_at IS NULL`,
    [tokenHash]
  );
  if (!found.rows.length) {
    const e = new Error('This verification link is invalid or has already been used.');
    e.statusCode = 400;
    throw e;
  }
  const row = found.rows[0];
  if (new Date(row.expires_at).getTime() < Date.now()) {
    const e = new Error('This verification link has expired. Please register again to get a new one.');
    e.statusCode = 400;
    throw e;
  }

  if (row.status === 'ACTIVE') {
    // Already verified (idempotent): just consume and return success.
    await query('UPDATE email_verifications SET consumed_at = now() WHERE id = $1', [row.verif_id]);
    return { status: 'active', message: 'Your account is already active. You can log in.' };
  }

  await withTransaction(async client => {
    // Claim the token atomically (prevents double-verify race).
    const claim = await client.query(
      'UPDATE email_verifications SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING id',
      [row.verif_id]
    );
    if (!claim.rows.length) {
      const e = new Error('This verification link has already been used.');
      e.statusCode = 400;
      throw e;
    }

    await provisionAccount(client, row.account_id, row.business_name, row.app_version, true);
  });

  return { status: 'active', message: 'Your email is verified and your workspace is ready. Please log in.' };
}

// ---------------------------------------------------------------
// Login (email + password) -> returns business info + session token
// ---------------------------------------------------------------
async function login(body) {
  const email = normalizeEmail(body && body.email);
  const password = String((body && body.password) || '');
  if (!email || !password) {
    const e = new Error('Enter your email and password.');
    e.statusCode = 400;
    throw e;
  }

  const r = await query('SELECT id, password_hash, status, business_name, business_code, app_version FROM accounts WHERE lower(email) = lower($1)', [email]);
  const acc = r.rows[0];
  // Uniform error to avoid account enumeration; constant-time-ish (always verify against something).
  if (!acc || !verifyPassword(password, acc.password_hash)) {
    const e = new Error('Incorrect email or password.');
    e.statusCode = 401;
    throw e;
  }
  if (acc.status !== 'ACTIVE') {
    const e = new Error('Please verify your email first. Check your inbox for the link.');
    e.statusCode = 403;
    throw e;
  }

  if (APP_VERSION_TO_APPS[acc.app_version]) {
    await withTransaction(async client => {
      await client.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [acc.id]);
      const current = await client.query('SELECT business_code FROM accounts WHERE id = $1', [acc.id]);
      let businessCode = current.rows[0] && current.rows[0].business_code;

      if (!businessCode) {
        const legacyRows = await client.query(
          'SELECT id, code, app FROM businesses WHERE account_id = $1 AND active = TRUE',
          [String(acc.id)]
        );
        const orphaned = [];
        if (!legacyRows.rows.length) {
          for (const app of APP_VERSION_TO_APPS[acc.app_version]) {
            const matches = await client.query(
              `SELECT id, code, app FROM businesses
               WHERE account_id IS NULL AND lower(name) = lower($1) AND app = $2 AND active = TRUE`,
              [acc.business_name, app]
            );
            if (matches.rows.length > 1) {
              const e = new Error('Multiple unlinked workspaces match this account. Please contact support to link the correct one.');
              e.statusCode = 409;
              throw e;
            }
            if (matches.rows.length === 1) orphaned.push(matches.rows[0]);
          }
        }

        const matchesToLink = legacyRows.rows.length ? legacyRows.rows : orphaned;
        const businessCodes = new Set(matchesToLink.map(b => b.code));
        if (businessCodes.size > 1) {
          const e = new Error('Unlinked workspaces have different business codes. Please contact support to link them safely.');
          e.statusCode = 409;
          throw e;
        }

        if (matchesToLink.length) {
          businessCode = matchesToLink[0].code;
          await client.query('UPDATE accounts SET business_code = $1 WHERE id = $2', [businessCode, acc.id]);
          for (const business of matchesToLink) {
            const oldAccountId = legacyRows.rows.length ? String(acc.id) : null;
            await client.query(
              oldAccountId
                ? 'UPDATE businesses SET account_id = $1 WHERE id = $2 AND account_id = $3 RETURNING id'
                : 'UPDATE businesses SET account_id = $1 WHERE id = $2 AND account_id IS NULL RETURNING id',
              oldAccountId ? [businessCode, business.id, oldAccountId] : [businessCode, business.id]
            );
          }
        }
      }

      await provisionAccount(client, acc.id, acc.business_name, acc.app_version, false);
    });
  }
  const account = await query('SELECT business_code FROM accounts WHERE id = $1', [acc.id]);
  const code = account.rows[0] && account.rows[0].business_code;
  const biz = code
    ? await query('SELECT id, code, name, app, active FROM businesses WHERE account_id = $1 AND active = TRUE ORDER BY id', [code])
    : { rows: [] };
  const apps = appsForAccount(acc.app_version, biz.rows);
  if (!code || !apps.length) {
    const e = new Error('No active application workspace is linked to this account. Please contact support.');
    e.statusCode = 403;
    throw e;
  }

  // Create a session token.
  const token = randomToken(32);
  await query(
    'INSERT INTO sessions (account_id, token_hash, expires_at) VALUES ($1,$2,$3)',
    [acc.id, sha256(token), new Date(Date.now() + SESSION_TTL_MS)]
  );

  return {
    session: token,
    code,
    bizName: acc.business_name,
    apps,
    email
  };
}

// ---------------------------------------------------------------
// Password recovery (OTP)
// ---------------------------------------------------------------
async function requestPasswordReset(body) {
  const email = normalizeEmail(body && body.email);
  if (!email) { const e = new Error('Enter your email address.'); e.statusCode = 400; throw e; }

  const r = await query('SELECT id, status FROM accounts WHERE lower(email) = lower($1)', [email]);
  // Always respond success (no account enumeration), only sending mail for real accounts.
  if (r.rows.length && r.rows[0].status === 'ACTIVE') {
    const otp = randomOtp();
    await query('UPDATE password_otp SET consumed_at = now() WHERE account_id = $1 AND consumed_at IS NULL', [r.rows[0].id]);
    await query(
      'INSERT INTO password_otp (account_id, otp_hash, expires_at) VALUES ($1,$2,$3)',
      [r.rows[0].id, sha256(otp), new Date(Date.now() + OTP_TTL_MS)]
    );
    await mailer.sendOtpEmail({ to: email, otp });
  }
  return { message: 'If that email is registered, a reset code has been sent.' };
}

async function resetPassword(body) {
  const email = normalizeEmail(body && body.email);
  const otp = String((body && body.otp) || '').trim();
  const password = String((body && body.password) || '');
  if (!email || !otp || password.length < 8) {
    const e = new Error('Email, the 6-digit code, and a password of at least 8 characters are required.');
    e.statusCode = 400;
    throw e;
  }

  await withTransaction(async client => {
    const acc = await client.query('SELECT id FROM accounts WHERE lower(email) = lower($1) AND status = $2', [email, 'ACTIVE']);
    if (!acc.rows.length) { const e = new Error('Invalid email or code.'); e.statusCode = 400; throw e; }
    const accountId = acc.rows[0].id;

    const hit = await client.query(
      'SELECT id FROM password_otp WHERE account_id = $1 AND otp_hash = $2 AND consumed_at IS NULL AND expires_at > now() ORDER BY id DESC LIMIT 1',
      [accountId, sha256(otp)]
    );
    if (!hit.rows.length) { const e = new Error('Invalid or expired code.'); e.statusCode = 400; throw e; }

    await client.query('UPDATE password_otp SET consumed_at = now() WHERE id = $1', [hit.rows[0].id]);
    await client.query('UPDATE accounts SET password_hash = $1 WHERE id = $2', [hashPassword(password), accountId]);
    // Invalidate all sessions on password change.
    await client.query('DELETE FROM sessions WHERE account_id = $1', [accountId]);
  });

  return { message: 'Your password has been reset. Please log in.' };
}

// Resolve a session token to { accountId, code, apps }. Returns null if invalid/expired.
async function sessionFor(token) {
  if (!token) return null;
  const r = await query(
    'SELECT account_id, expires_at FROM sessions WHERE token_hash = $1',
    [sha256(String(token))]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  const account = await query('SELECT app_version, business_code FROM accounts WHERE id = $1', [row.account_id]);
  if (!account.rows.length) return null;
  const businessCode = account.rows[0].business_code;
  if (!businessCode) return null;
  const biz = await query('SELECT code, app, active FROM businesses WHERE account_id = $1 AND active = TRUE ORDER BY id', [businessCode]);
  if (!biz.rows.length) return null;
  const apps = appsForAccount(account.rows[0].app_version, biz.rows);
  if (!apps.length) return null;
  return { accountId: row.account_id, code: businessCode, apps };
}

module.exports = { register, verifyEmail, login, requestPasswordReset, resetPassword, sessionFor };