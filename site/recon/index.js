'use strict';

/*
 * Three-way reconciliation page (milestone 9).
 *
 *   GET /    the last completed reconciliation across Okta, Entra ID and Google
 *
 * Mounted by server.js, which passes in its page() layout so this section looks
 * like the rest of the site. No client-side JavaScript: the snapshot is fetched
 * upstream and masked on the server, so what reaches the browser is final.
 *
 * Nothing here can write. The page is a read of a read.
 */

const express = require('express');
const { createUpstream } = require('./upstream');
const { maskSnapshot } = require('./mask-snapshot');
const { reconPage, emptyPage } = require('./views');

function createReconRouter({ page, config, masker, upstream, log = console } = {}) {
  if (typeof page !== 'function') throw new Error('createReconRouter needs the site page() layout');
  if (!config) throw new Error('createReconRouter needs config');
  if (!masker || typeof masker.pseudonym !== 'function') {
    throw new Error('createReconRouter needs a masker from dashboard/mask.js');
  }

  const client = upstream || createUpstream(config);
  const router = express.Router();

  const send = (res, status, html) =>
    res.status(status).set('Cache-Control', 'public, max-age=120').type('html').send(html);

  router.get('/', async (req, res, next) => {
    let result;
    try {
      result = await client.get();
    } catch (err) {
      log.error(`[recon] snapshot unavailable: ${err.message}`);
      // Cold cache and a failed read: say so plainly rather than inventing a
      // reconciliation. There is nothing to show and that is the honest answer.
      return send(
        res,
        503,
        page('Reconciliation · Glasscliff labs', emptyPage(), { current: 'labs' })
      );
    }

    if (!result.snapshot) {
      return send(
        res,
        200,
        page('Reconciliation · Glasscliff labs', emptyPage(), { current: 'labs' })
      );
    }

    if (result.stale) {
      log.warn(`[recon] serving the previous snapshot: ${result.error && result.error.message}`);
    }

    let masked;
    try {
      masked = maskSnapshot(result.snapshot, {
        pseudonym: masker.pseudonym,
        generatedAt: result.snapshot.generatedAt,
        durationMs: result.snapshot.durationMs,
        stale: Boolean(result.stale),
      });
    } catch (err) {
      // A snapshot that cannot be masked is never rendered unmasked.
      log.error(`[recon] masking failed, refusing to render: ${err.message}`);
      return next(err);
    }

    return send(
      res,
      200,
      page('Reconciliation · Glasscliff labs', reconPage(masked), {
        current: 'labs',
        description:
          'Three-way reconciliation across Okta, Entra ID and Google Cloud Identity. ' +
          'Read-only, people shown as pseudonyms.',
      })
    );
  });

  return router;
}

module.exports = { createReconRouter };
