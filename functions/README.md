# functions — Glasscliff lab back end

Azure Functions, Node 20, v4 programming model.

- `src/functions/scim.js`: SCIM 2.0 endpoint for Glasscliff Expenses. Okta calls it.
- `src/functions/lifecycle.js`: operator API for hire, transfer, terminate, status and operations, plus the Okta event hook.
- `src/functions/demo.js`: the dashboard's visitor demo. Throwaway people, rate-limited and deleted on expiry.
- `src/functions/recon.js`: the reconciler. Runs on a timer at 06:17 and 18:17 UTC. Serves `/api/recon/snapshot` and `/api/recon/run` behind the operator key.
- `src/functions/health.js`: anonymous health check.
- `src/lib/recon/`: the read-only directory readers (`sources/`), the comparison (`reconcile.js`), and run and finding history (`history.js`).

## Reconciliation storage

Everything is in the private `recon` blob container:

- `latest.json`: the last complete comparison.
- `history/<iso>.json`: one file per complete run.
- `run-history.json`: every attempt, failed ones included, and each finding's first seen, last seen and resolved times.

A failed directory read publishes nothing and resolves nothing. It is only recorded as a failed attempt.

## Tests

- `npm test`: reconciler, history and downstream checks. No cloud access needed.
- `npm run test:storage`: lifecycle against storage. Needs Azurite on its default ports.

## Package

`npm run package` builds `../functions.zip` with production `node_modules`. Deploy it with `az functionapp deployment source config-zip`, or let `.github/workflows/deploy.yml` deploy it.
