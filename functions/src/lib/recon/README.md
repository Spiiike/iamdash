# Reconciliation rules

The reconciler reads Okta, Entra ID and Google Cloud Identity twice a day (06:17 and 18:17 UTC), joins the three on the login address, and reports every disagreement as a finding. The rules live in [`reconcile.js`](reconcile.js), which is a pure function: directory records in, findings out. The tests are in [`functions/test/recon/`](../../../test/recon/).

Each finding carries a section number, such as §9. Those numbers come from the runbook I kept while building the federation, where each section records a connector behaviour I measured. The runbook isn't published, so this page lists what each section covers and which rules come from it. The reconciliation page links each finding here.

## How records are matched

- **Join key.** The login address, trimmed and lowercased. It is the same in all three directories by construction, because Okta provisions both downstream accounts from it. If two records in one directory share a key, the first one wins.
- **What Okta's status should mean downstream.** `ACTIVE`, `PROVISIONED`, `PASSWORD_EXPIRED`, `LOCKED_OUT` and `RECOVERY` should leave the downstream accounts enabled. `SUSPENDED` and `DEPROVISIONED` should disable them. `STAGED` users haven't been activated, so no downstream account is expected yet. The mapping is in [`model.js`](model.js).
- **Which Okta users are read.** Okta's plain user list leaves out `DEPROVISIONED` users, so I read them with a second, filtered request. Without it, a person I'd offboarded looked as if they had never existed in Okta.
- **Assignment.** A user who isn't assigned to the Office 365 or Google app in Okta isn't expected to have an account in that directory. Assignment only affects whether a missing account is a finding.
- **Exceptions.** Break-glass and connector accounts are meant to exist downstream with no Okta identity. They're listed in the `RECON_EXCEPTIONS` setting and reported as accepted, not as orphans.

## Section 2: join key and anchor

| Rule | Severity | Fires when |
| --- | --- | --- |
| `anchor_missing` | high | An Entra account matched to an Okta user has no `onPremisesImmutableId`. Federated sign-in matches on that anchor, so the account can't be signed into through Okta, however healthy it looks in the portal. |
| `duplicate_candidate` | high | Two accounts in one directory have the same first and last name under different addresses, and at least one of them has no Okta identity. That is what a failed soft match looks like: the join key differed, so the connector created a second account instead of linking the first. It's a candidate, not proof. |

## Section 4: attributes and OU placement

| Rule | Severity | Fires when |
| --- | --- | --- |
| `attribute_drift` | medium | First name, last name, title or department differs between Okta and a matched downstream account. Okta owns these, so an empty value in Okta should have cleared the downstream one. One finding per attribute per directory. |
| `ou_misplacement` | medium | A matched Google account sits outside the managed OU (`/Okta Users` unless `RECON_MANAGED_OU` says otherwise). The SSO profile is assigned to that OU, so it doesn't cover the account. The comparison is exact, not by subtree. |

## Section 5: provisioning

| Rule | Severity | Fires when |
| --- | --- | --- |
| `missing_downstream` | high | The user is assigned to the app in Okta and should be enabled, but the directory has no account for them. Provisioning failed or never ran. |
| `provisioning_pending` | info | The Okta user is `STAGED`, so no account is expected yet. |

## Section 6: accepted exceptions

| Rule | Severity | Fires when |
| --- | --- | --- |
| `accepted_exception` | info | A downstream account with no Okta identity is on the exception list. It's shown so the list stays visible, but it doesn't count as drift. |

## Section 8: accounts in SSO scope with no Okta identity

| Rule | Severity | Fires when |
| --- | --- | --- |
| `unmanaged_in_scope` | critical | A Google account in the managed OU has no Okta identity and isn't an exception. The OU's SSO profile will send it to an IdP that has never heard of it, so it can't sign in. Reported instead of `orphan`. |

## Section 9: presence and access

| Rule | Severity | Fires when |
| --- | --- | --- |
| `access_not_revoked` | critical | Okta says the person should be disabled (`SUSPENDED` or `DEPROVISIONED`), but their account in Entra or Google is still enabled. This is the failure offboarding exists to prevent. |
| `access_not_granted` | high | Okta says the person should be enabled, but the downstream account is disabled. |
| `orphan` | high | A downstream account has no Okta identity and isn't an exception or in the managed Google OU. It either predates the integration or its access was never revoked. |

## What a run publishes

- **All or nothing.** If any of the three reads fails, the run publishes nothing, because a partial read would make every account in the missing directory look as if it had vanished.
- **Verdict.** A run is `clean` when every finding is info level, and `drift` otherwise. A person's row agrees only when all their findings are info level. A duplicate candidate can make the run `drift` without marking a single person's row, because it compares people against each other.
- **History.** Non-info findings are tracked from run to run, so the page can show when each one first appeared and when it was resolved. A failed run doesn't resolve anything. The store keeps the last 60 runs and resolved findings for 30 days.
- **What it doesn't check.** The rules compare account data. They don't sign anyone in, test MFA, or check what the connectors are allowed to do.
