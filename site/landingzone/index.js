'use strict';
/*
 * Azure landing zone pages (milestone 8).
 *
 *   GET  /         live view: hierarchy, guardrails, tag coverage, spend
 *   POST /check    "try to break the rules": asks Azure Policy, deploys nothing
 *   GET  /about    case study
 *
 * Mounted by server.js, which passes in its page() layout so this section
 * looks exactly like the rest of the site. No client-side JavaScript: the
 * check is an ordinary form post that re-renders the page with the answer.
 */
const express = require('express');
const { createArmClient } = require('./azure');
const { createOverview } = require('./overview');
const { createChecker, normalize, DEFAULTS } = require('./check');
const { landingZonePage } = require('./views');
const { aboutPage } = require('./about');

function createLandingZoneRouter({ page, arm, log = console, managementGroup = process.env.LZ_MANAGEMENT_GROUP || 'glasscliff', policyResourceGroup = process.env.LZ_POLICY_RESOURCE_GROUP || '', perIpLimit = 20, windowMs = 5 * 60 * 1000 } = {}) {
  if (typeof page !== 'function') throw new Error('createLandingZoneRouter needs the site page() layout');
  const client = arm || createArmClient();
  const overview = createOverview({ arm: client, managementGroup, log });
  const checker = createChecker({ arm: client, log, resourceGroup: /^[\w.()-]{1,90}$/.test(policyResourceGroup) ? policyResourceGroup : '', getSubscriptionId: async () => (await overview.get()).subscriptionId });
  const router = express.Router();
  const hits = new Map(); // ip -> [timestamps]

  const send = (res, status, html) => res.status(status).set('Cache-Control', 'no-store').type('html').send(html);
  const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 64);
  const limited = (ip) => {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 5000) hits.clear();
    return recent.length > perIpLimit;
  };

  async function render(req, res, { choice = normalize(DEFAULTS), result = null, status = 200 } = {}) {
    let ov;
    try {
      ov = await overview.get();
    } catch (err) {
      log.error(`[landing-zone] overview failed: ${err.message}`);
      ov = { loadedAt: new Date().toISOString(), hierarchy: null, guardrails: null, tagging: null, budget: null };
    }
    send(res, status, page('Azure landing zone · Glasscliff', landingZonePage({ overview: ov, basePath: req.baseUrl, choice, result })));
  }

  router.get('/', (req, res, next) => render(req, res).catch(next));

  router.post('/check', express.urlencoded({ extended: false, limit: '2kb', parameterLimit: 20 }), async (req, res, next) => {
    const choice = normalize(req.body || {});
    if (limited(ipOf(req))) {
      return render(req, res, { choice, status: 429, result: { error: "That's a lot of checks in a few minutes. Try again shortly." } }).catch(next);
    }
    try {
      const r = await checker.check(choice);
      return render(req, res, { choice: r.choice, result: r });
    } catch (err) {
      log.error(`[landing-zone] policy check failed: ${err.message}`);
      const message = err.status === 403
        ? "The site isn't allowed to ask Azure Policy yet. That permission is still being set up."
        : "Azure Policy didn't answer. Try again in a minute.";
      return render(req, res, { choice, status: 502, result: { error: message } }).catch(next);
    }
  });

  router.get('/about', (req, res) => send(res, 200, page('About this landing zone · Glasscliff', aboutPage({ basePath: req.baseUrl }))));

  return router;
}

module.exports = { createLandingZoneRouter };
