# site — projects.glasscliff.online

Express app on App Service (`wetcliff`). Start command: `node server.js`.

| Route | What |
|---|---|
| `/` | Home page: the lab directory |
| `/labs/identity` | Identity lab index |
| `/labs/identity/about` | Identity lab write-up |
| `/labs/identity/dashboard/` | Operations dashboard: live runs, labelled replays, the visitor demo, and its independent readback |
| `/labs/identity/expenses/` | Glasscliff Expenses: Okta sign-in, SCIM-account check, a Sessions row per login |
| `/labs/identity/federation` | Federation write-up |
| `/labs/identity/recon` | Reconciliation: latest comparison, finding history, every run |
| `/labs/landing-zone/` | Landing zone live view and policy check |
| `/labs/landing-zone/about` | Landing zone write-up |
| `/healthz` | `{"status":"ok"}`. With the operator key header it also returns OIDC diagnostics: a fingerprint of the secret, never the secret itself. |

## Settings

These come from the app settings `main.bicep` merges into the web app:

- `EXPENSES_OIDC_*`, `LAB_STORAGE_ACCOUNT` and `LAB_TABLE_*` for Expenses.
- `LAB_LIFECYCLE_ENDPOINT`, `LAB_OPERATOR_KEY` and `LAB_SYNTHETIC_SCENARIO_CONTAINER` for the dashboard.
- `RECON_*` for reconciliation.

The dashboard calls the lifecycle API server-side. The operator key never reaches the browser, and every response goes through `dashboard/mask.js`, which is an allowlist. Without the operator key, live runs and the demo are off, and replays still work.

Expenses requests that arrive on a host other than the one in `EXPENSES_OIDC_POST_LOGOUT_REDIRECT_URI` are redirected to that host, because Okta returns the browser there and the sign-in cookie must match. Set `publicHostName` in `main.parameters.json` so that host is the custom domain.

## Tests

`npm ci && npm test` runs six suites: site routes, Expenses sign-in, dashboard (masking, demo, provenance, readback), landing zone, reconciliation, and replays. No Azure or Okta access is needed.

## Recording a replay

```bash
LAB_LIFECYCLE_ENDPOINT=https://<function>.azurewebsites.net/api/lifecycle \
LAB_OPERATOR_KEY=... \
node tools/record-scenario.js <operationId> --id <id> --order <n> --title "..." --description "..."
```

The file lands in `dashboard/scenarios/` stamped `provenance: { kind: 'recorded', capturedAt, outcome }`. To record a run that didn't finish (`awaiting_scim`, `failed`), add `--allow-unfinished`.
