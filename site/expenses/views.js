'use strict';

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// RowKey is <UTC timestamp>-<random>; show the random part, which identifies the session.
const shortId = (rowKey) => {
  const k = String(rowKey || '');
  return k.slice(k.indexOf('-') + 1, k.indexOf('-') + 9); // timestamp part has no dashes
};

const fmtTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? esc(iso) : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
};

const CSS_HREF = '/labs/assets/glasscliff.css';

// The app keeps its own small shell (it stands in for a separate product) but
// wears the site's stylesheet: same navy, same type, same hairlines.
function page(title, { strip, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${esc(title)} · Glasscliff Expenses</title>
<link rel="stylesheet" href="${CSS_HREF}">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="wrap">
<p class="brandline"><b>glasscliff</b> expenses</p>
${strip || ''}
<main id="main">
${body}
</main>
</div>
</body>
</html>`;
}

const SAMPLE_CLAIMS = [
  ['2026-09-02', 'Train to client site', 'Approved', '48.20'],
  ['2026-09-09', 'Team lunch', 'Submitted', '112.75'],
  ['2026-09-15', 'Conference registration', 'Draft', '395.00'],
];

function home({ basePath, account, session }) {
  const strip = `<div class="bar live" role="status">
<span>Session active since ${fmtTime(session.createdAt)} · ID ${esc(shortId(session.rowKey))}</span>
<form method="post" action="${esc(basePath)}/auth/logout"><button class="btn quiet" type="submit">Sign out</button></form></div>`;
  const rows = SAMPLE_CLAIMS.map(
    ([d, what, st, amt]) => `<tr><td>${d}</td><td>${esc(what)}</td><td>${st}</td><td class="n">$${amt}</td></tr>`
  ).join('');
  return page('Your claims', {
    strip,
    body: `<section class="hero">
<h1>${esc(account.displayName)}</h1>
<p>Signed in with Okta as <code>${esc(account.userName)}</code>.</p>
</section>
<section class="section">
<dl class="kv">
<dt>Title</dt><dd>${esc(account.title || 'Not set')}</dd>
<dt>Department</dt><dd>${esc(account.department || 'Not set')}</dd>
<dt>Manager</dt><dd>${esc(account.manager || 'Not set')}</dd>
</dl>
<p class="note">These details come from your Expenses account, which Okta keeps up to date over SCIM.</p>
</section>
<section class="section">
<h2>Recent claims</h2>
<table class="table"><thead><tr><th>Date</th><th>Description</th><th>Status</th><th class="n">Amount</th></tr></thead><tbody>${rows}</tbody></table>
<p class="note">Sample claims for the lab.</p>
</section>`,
  });
}

const REASONS = {
  account_deactivated: ['Your Expenses account was deactivated', 'Okta removed your access to Expenses, so your session was closed.'],
  okta_refresh_rejected: ['Okta ended your sign-in', 'Okta no longer accepts this sign-in, so Expenses closed your session.'],
  session_closed: ['Your Expenses session was closed', 'An administrator closed this session. You can sign in again.'],
};

function sessionEnded({ basePath, reason, sessionId }) {
  const [title, explained] = REASONS[reason] || REASONS.session_closed;
  const again = reason === 'account_deactivated' ? '' : `<p class="page-actions"><a class="btn" href="${esc(basePath)}/auth/login">Sign in again</a></p>`;
  return page('Session ended', {
    strip: `<div class="bar ended" role="status"><span>Session ended</span></div>`,
    body: `<section class="hero">
<h1>${esc(title)}</h1>
<p>${esc(explained)}</p>
</section>
<section class="section">
<dl class="kv"><dt>Reason code</dt><dd><code>${esc(reason)}</code></dd><dt>Session ID</dt><dd>${esc(shortId(sessionId))}</dd></dl>${again}
</section>`,
  });
}

function landing({ basePath }) {
  return page('Sign in', {
    strip: `<div class="bar neutral"><span>Not signed in</span></div>`,
    body: `<section class="hero">
<h1>Sign in to see your expense claims</h1>
<p>Glasscliff Expenses uses your Okta account. You need an Expenses account, which Okta creates when you're assigned the app.</p>
<p class="page-actions"><a class="btn" href="${esc(basePath)}/auth/login">Sign in with Okta</a></p>
</section>`,
  });
}

function noAccess({ basePath, userName, inactive }) {
  return page('No access', {
    strip: `<div class="bar neutral"><span>Not signed in to Expenses</span></div>`,
    body: inactive
      ? `<section class="hero">
<h1>Your Expenses account is deactivated</h1>
<p>Okta signed you in as <code>${esc(userName)}</code>, but the matching Expenses account is inactive. Ask an administrator to reactivate you in Okta.</p>
</section>`
      : `<section class="hero">
<h1>You don't have an Expenses account</h1>
<p>Okta signed you in as <code>${esc(userName)}</code>, but Expenses has no account for that login. Accounts are created when Okta assigns you the Expenses app.</p>
</section>`,
  });
}

function error({ basePath, title, message, ref }) {
  return page(title, {
    strip: `<div class="bar ended"><span>Sign-in failed</span></div>`,
    body: `<section class="hero">
<h1>${esc(title)}</h1>
<p>${esc(message)}</p>${ref ? `\n<p class="note">Reference <code>${esc(ref)}</code>; search wetcliff's logs for it.</p>` : ''}
<p class="page-actions"><a class="btn" href="${esc(basePath || '')}/auth/login">Try again</a></p>
</section>`,
  });
}

function misconfigured(problems) {
  return page('Not configured', {
    strip: `<div class="bar ended"><span>Expenses is not configured</span></div>`,
    body: `<section class="hero">
<h1>Expenses sign-in isn't configured yet</h1>
</section>
<section class="section">
<ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
</section>`,
  });
}

module.exports = { home, landing, sessionEnded, noAccess, error, misconfigured, esc };
