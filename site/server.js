'use strict';
/*
 *
 *   /                         home page
 *   /labs/identity            lab landing
 *   /labs/identity/about      case study: why this exists and how it works
 *   /labs/identity/dashboard  public operations dashboard, masked (milestone 4)
 *   /labs/identity/federation case study: Okta into Entra ID and Google Cloud Identity
 *   /labs/identity/recon      three-way reconciliation, masked (milestone 9)
 *   /labs/identity/expenses   Glasscliff Expenses, Okta sign-in (milestone 3)
 *   /labs/landing-zone        Azure landing zone, live view + policy check (milestone 8)
 *   /labs/landing-zone/about  case study for the landing zone
 *   /healthz                  plain health check
 *
 */
const express = require('express');
const { createExpensesRouter } = require('./expenses');
const { createDashboardRouter } = require('./dashboard');
const { createLandingZoneRouter } = require('./landingzone');
const { createReconRouter } = require('./recon');
const { createConfig: reconConfig } = require('./recon/config');
const { notDeployedPage } = require('./recon/views');
const { federationPage } = require('./federation/view');
const { createMasker } = require('./dashboard/mask');
const { createPage, esc } = require('./layout');
const path = require('path');
const crypto = require('crypto');

// One shell for every page on the site: navy field, hairlines, two typefaces.
const page = createPage();

const app = express();
app.disable('x-powered-by');

const EXPENSES_MOUNT = '/labs/identity/expenses';
const DASHBOARD_MOUNT = '/labs/identity/dashboard';
const LANDING_ZONE_MOUNT = '/labs/landing-zone';
const RECON_MOUNT = '/labs/identity/recon';

// Okta sends the browser back to the host in EXPENSES_OIDC_REDIRECT_URI, and
// the sign-in cookie only exists on the host the user started from. If someone
// arrives on another host (a custom domain, say), move them to the configured
// one first, or every sign-in would fail with "Sign-in expired".
const configuredBase = process.env.EXPENSES_OIDC_POST_LOGOUT_REDIRECT_URI || process.env.EXPENSES_BASE_URL || '';
const canonicalHost = configuredBase ? new URL(configuredBase).host : '';
app.use(EXPENSES_MOUNT, (req, res, next) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (canonicalHost && host && host.toLowerCase() !== canonicalHost.toLowerCase() && req.method === 'GET') {
    return res.redirect(302, `https://${canonicalHost}${req.originalUrl}`);
  }
  next();
});
// The shared stylesheet. Dashboard CSP allows 'self' styles for exactly this.
app.use('/labs/assets', express.static(path.join(__dirname, 'public/labs/assets'), { maxAge: '1h' }));

app.use(EXPENSES_MOUNT, createExpensesRouter());
app.use(DASHBOARD_MOUNT, createDashboardRouter());
app.use(LANDING_ZONE_MOUNT, createLandingZoneRouter({ page }));

// Reconciliation. Without its settings the site must still start, so a missing
// reconciler mounts an honest "not deployed" page instead of crashing at boot.
let reconLive = false;
try {
  const config = reconConfig();
  app.use(RECON_MOUNT, createReconRouter({
    page,
    config,
    // The dashboard's own masking secret (LAB_OPERATOR_KEY), so a person's
    // pseudonym is the same on both pages.
    masker: createMasker(config.maskSecret),
  }));
  reconLive = true;
} catch (err) {
  console.warn(`[recon] not live: ${err.message}`);
  app.get([RECON_MOUNT, `${RECON_MOUNT}/`], (req, res) =>
    res.set('Cache-Control', 'no-store').type('html').send(
      page('Reconciliation · Glasscliff labs', notDeployedPage(), { current: 'labs' })));
}

// ---------------------------------------------------------------- pages ----
const send = (res, html) => res.set('Cache-Control', 'no-store').type('html').send(html);

const node = ({ href, stem, name, note, state, stateClass = 'live' }) => {
  const inner = `<span class="n-stem" aria-hidden="true">${stem}</span><span class="n-name">${name}</span><span class="n-note">${note}</span><span class="n-state ${stateClass}">${state}</span>`;
  return href ? `<a class="node" href="${href}">${inner}</a>` : `<div class="node branch">${inner}</div>`;
};
const reconState = () => (reconLive ? { state: 'live' } : { state: 'soon', stateClass: 'soon' });

app.get('/', (req, res) =>
  send(res, page('Glasscliff labs', `
<section class="hero">
<h1>Identity and infrastructure, running where you can poke it.</h1>
<p>I'm Antalon Jackson Jr, a systems administrator working toward infrastructure engineering. These are labs I built and broke on purpose. The ones marked live are running now: sign in to one, deploy against another, and read what went wrong along the way.</p>
</section>

<nav class="index" aria-label="Labs">
<div class="index-root">glasscliff.online/</div>
${node({ stem: '|-- ', name: 'labs/identity/', note: 'Okta owns the account, three systems obey it', state: '', stateClass: '' })}
${node({ href: `${EXPENSES_MOUNT}/`, stem: '|   |-- ', name: 'expenses', note: 'an app that trusts Okta for sign-in', state: 'live' })}
${node({ href: `${DASHBOARD_MOUNT}/`, stem: '|   |-- ', name: 'dashboard', note: 'watch a hire and an offboarding run', state: 'live' })}
${node({ href: '/labs/identity/federation', stem: '|   |-- ', name: 'federation', note: 'one source of truth, two directories', state: 'verified' })}
${node({ href: RECON_MOUNT, stem: '|   `-- ', name: 'recon', note: 'do all three directories still agree?', ...reconState() })}
${node({ href: `${LANDING_ZONE_MOUNT}/`, stem: '`-- ', name: 'labs/landing-zone/', note: "try to deploy something it won't allow", state: 'live' })}
</nav>

<div class="triptych">
<article class="panel">
<span class="path">/labs/identity</span>
<h2><a href="/labs/identity">Okta identity lifecycle</a></h2>
<p>Hire someone, move them, offboard them. A lifecycle API drives Okta, Okta provisions an app over SCIM, and every step is checked against what actually landed rather than what was requested.</p>
</article>
<article class="panel">
<span class="path">/labs/identity/federation</span>
<h2><a href="/labs/identity/federation">Directory federation</a></h2>
<p>The same Okta account pushed into Entra ID and Google Cloud Identity, with both directories sending sign-in to Okta. The two vendors disagree about more than you'd expect.</p>
</article>
<article class="panel">
<span class="path">/labs/landing-zone</span>
<h2><a href="${LANDING_ZONE_MOUNT}/">Azure landing zone</a></h2>
<p>Management groups, guardrail policies, central logging and a budget, all in Bicep. The policies are real: describe a blocked resource and watch Azure say no.</p>
</article>
</div>

<section class="section">
<h2>How to read these</h2>
<p class="lede">Where a page says something is running, you can go and make it do the thing.</p>
<div class="rules"><dl>
<dt>live</dt><dd>Running right now against real cloud tenants. You can interact with it.</dd>
<dt>verified</dt><dd>Built and tested end to end, with the results and the failures written up.</dd>
<dt>soon</dt><dd>Built, but not deployed yet.</dd>
<dt>pseudonyms</dt><dd>Anywhere a person appears, they appear as a stable fake name. Addresses and directory object ids never leave the tenant. The only names and titles you'll see are the ones a visitor picked for their own demo person.</dd>
<dt>free tiers</dt><dd>Okta Integrator Free, Entra ID Free, Google Cloud Identity Free and an Azure student subscription. The constraints are part of the exercise.</dd>
</dl></div>
<p class="byline">Why I built them: <a href="${LANDING_ZONE_MOUNT}/about">the landing zone</a> · <a href="/labs/identity/about">the identity lab</a></p>
</section>`, { current: 'labs', description: 'Working labs from Antalon Jackson Jr: an Okta identity lifecycle, directory federation into Entra ID and Google, and an Azure landing zone.' })));

app.get(['/labs/identity', '/labs/identity/'], (req, res) =>
  send(res, page('Identity Lifecycle Lab · Glasscliff', `
<section class="hero">
<h1>Identity Lifecycle Lab</h1>
<p>Okta is the source of truth for identities. A lifecycle API creates, changes and deactivates people in Okta; Okta provisions the Glasscliff Expenses app over SCIM; every step is checked against what actually landed.</p>
<p class="byline"><a href="/labs/identity/about">About this project</a> · <a href="https://github.com/Spiiike/iamdash">Source</a> · <a href="https://github.com/Spiiike/iamdash/tree/main/functions/test">Functions tests</a> · <a href="https://github.com/Spiiike/iamdash/tree/main/site/test">Site tests</a></p>
</section>

<nav class="index" aria-label="Identity lab">
<div class="index-root">labs/identity/</div>
${node({ href: `${EXPENSES_MOUNT}/`, stem: '|-- ', name: 'expenses', note: 'sign in with Okta; access follows SCIM', state: 'live' })}
${node({ href: `${DASHBOARD_MOUNT}/`, stem: '|-- ', name: 'dashboard', note: 'hires, moves and leavers, step by step', state: 'live' })}
${node({ href: '/labs/identity/federation', stem: '|-- ', name: 'federation', note: 'Okta into Entra ID and Google', state: 'verified' })}
${node({ href: RECON_MOUNT, stem: '`-- ', name: 'recon', note: 'do all three directories still agree?', ...reconState() })}
</nav>

<section class="section">
<p>To sign in to Expenses, start on the dashboard: it creates a throwaway person for you and shows their username and password once. Everyone else on the dashboard is shown as a pseudonym.</p>
</section>`, { current: 'labs' })));

app.get(['/labs/identity/federation', '/labs/identity/federation/'], (req, res) =>
  send(res, page('Directory federation · Glasscliff labs', federationPage({ reconLive }), {
    current: 'labs',
    description: 'Okta as the source of truth for Entra ID and Google Cloud Identity: provisioning, federation, and a reconciler.',
  })));

app.get(['/labs/identity/about', '/labs/identity/about/'], (req, res) =>
  send(res, page('About this project · Glasscliff', `
<section class="hero">
<h1>About this project</h1>
<p>I'm Antalon Jackson Jr, a system administrator that is currently the primary M365 and Azure admin for a SMB environment. I'm working towards diving deeper into infrastructure and systems engineering, and identity is a key part that keeps pulling my attention.</p>
<p>Particularly, onboarding. Since it's such a big part of how a new hire experiences a company, I like to see it work smoothly/without issue. Offboarding matters for a different reason: security and compliance don't really care about anyone's first day, they care that access actually goes away when it should. I've done this in Entra, but I wanted to see how joiner-mover-leaver cycle works within Okta without just watching videos.</p>
</section>

<section class="section">
<h2>What it does</h2>
<p>Three operations run against an Okta dev. org: hire, role change and offboarding. Each one calls the Okta API, waits for Okta to push the change into a downstream app over SCIM, then checks what actually landed instead of assuming it worked.</p>
<p>The downstream app is <i>Glasscliff Expenses</i>. A totally not made-up app that provides something real on the other end of the provisioning. It uses Okta for sign-in, writes a session row for each login, and checks that row on every page view. Offboarding someone who is signed in takes their session away about five seconds later, which you can watch on the <a href="${DASHBOARD_MOUNT}/">dashboard</a>.</p>
</section>

<section class="section">
<h2>How it's put together</h2>
<ul class="prose">
  <li>Lifecycle API on Azure Functions: hire, transfer, terminate and status, behind an operator key.</li>
  <li>A SCIM 2.0 endpoint that Okta provisions into, which stores every call it receives as evidence.</li>
  <li>Expenses on App Service: OIDC authorization code with PKCE and refresh tokens, sessions in Table Storage.</li>
  <li>This site's dashboard, public and read-only, with people shown as pseudonyms.</li>
  <li>Azure infrastructure in Bicep: managed identities and Key Vault references rather than secrets in app settings, and storage permissions scoped to single tables and containers.</li>
</ul>
</section>

<section class="section">
<h2>Three things that broke</h2>
<p>These were just fun troubleshooting things.</p>
<p><strong>Sign-on passed, but tokens were refused.</strong> Okta said "You are not allowed to access this app", which reads like an assignment problem. It wasn't. The System Log showed the sign-on policy returning ALLOW, then <code>app.oauth2.as.authorize</code> failing with <code>no_matching_policy</code> against the default authorization server. App assignment and the authorization server's own access policy are two separate gates, and I'd only set up the first. Custom authorization servers deny by default until a rule covers the client, the grant type and every scope requested.</p>
<p><strong>Ended sessions didn't look ended.</strong> My first version of the Expenses session marked its row inactive when someone signed out. But the SCIM code deletes session rows on deactivation, and the offboarding check counts every row left in that user's partition. So my politely retired rows looked like live sessions to the verification step. The fix was to follow the convention that already existed: a session exists or it doesn't.</p>
<p><strong>A client ID with an apostrophe (') at the end.</strong> I made a typo</p>
</section>

<section class="section">
<h2>What I may change next</h2>
<ul class="prose">
  <li>The offboarding check has a safety net that cleans up any sessions left behind, which is good behaviour but hides whether SCIM did the work. The SCIM step records its own count, so the two need to be read together.</li>
  <li>Upgrade the runtime to Node.js 22.</li>
  <li>Adding more of a showy flair to the dashboard.</li>
</ul>
</section>`, { current: 'labs' })));

// Health check. Public callers get liveness only. The OIDC diagnostics (client
// id, authority, redirect URI, and a fingerprint of the secret the running app
// loaded) are for the operator: send the same x-lab-operator-key header the
// lifecycle API uses. The secret is never returned, only the first 8 hex of its
// SHA-256 and its length. Compare with:  printf '%s' '<secret>' | sha256sum
function operatorKeyMatches(req) {
  const want = process.env.LAB_OPERATOR_KEY || '';
  const header = (process.env.LAB_OPERATOR_HEADER || 'x-lab-operator-key').toLowerCase();
  const given = String(req.headers[header] || '');
  if (!want || want.startsWith('@Microsoft.KeyVault') || want.startsWith('SET-ME-') || !given) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

app.get('/healthz', (req, res) => {
  const body = { status: 'ok', time: new Date().toISOString() };
  if (operatorKeyMatches(req)) {
    const raw = process.env.EXPENSES_OIDC_CLIENT_SECRET || '';
    const source = !raw ? 'missing'
      : raw.startsWith('@Microsoft.KeyVault') ? 'unresolved-keyvault-reference'
      : raw.startsWith('SET-ME-') ? 'placeholder'
      : 'resolved';
    body.oidc = {
      clientId: process.env.EXPENSES_OIDC_CLIENT_ID || null,
      authority: process.env.EXPENSES_OIDC_AUTHORITY || null,
      redirectUri: process.env.EXPENSES_OIDC_REDIRECT_URI || null,
      secretSource: source,
      secretLength: raw.length,
      secretFingerprint: source === 'resolved' ? crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8) : null,
    };
  }
  res.set('Cache-Control', 'no-store').json(body);
});

app.use((req, res) =>
  res.status(404).set('Cache-Control', 'no-store').type('html').send(page('Not found · Glasscliff', `
<section class="hero">
<h1>Page not found</h1>
<p>Nothing lives at <code>${esc(req.path)}</code>.</p>
<p class="byline"><a href="/">Back to Glasscliff</a></p>
</section>`)));

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  app.listen(port, () => console.log(`[wetcliff] listening on ${port}`));
}

// Exposed for tests that render a section with the site's own layout.
app.locals.page = page;

module.exports = app;
