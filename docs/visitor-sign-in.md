# Visitor sign-in demo

"Run one yourself" on the operations dashboard lets a visitor:

1. Make a throwaway person. They pick a display name and a job title from a list.
2. Sign in to Glasscliff Expenses as that person, in another tab, with a username and password shown once on the page.
3. Change the person's title, and see the new title in Expenses after a refresh.
4. Offboard them, and watch the session they are using end. Refreshing the Expenses tab shows "Your Expenses account was deactivated".

The person is deleted from Okta automatically after `DEMO_TTL_MINUTES` (8 by default).

## What is real, and what protects it

- **The sign-in is real.** The visitor authenticates to Okta with a password and Expenses writes a real session row. The demo no longer writes a simulated one.
- **The session ending is real, and the page says who ended it.** Okta deactivates the person, Okta's SCIM call deactivates the Expenses account, and the SCIM endpoint deletes the session rows in the same request. The page reads `sessionsEnded` from that SCIM call. If the lifecycle API's safety net had to remove the session instead, the page says that the SCIM path failed.
- **The login is never the visitor's.** It is always `demo-<hex>@DEMO_EMAIL_DOMAIN`, invented by the Functions app. Okta mails a profile's email address for activations and notifications, so a typed address would let anyone send mail to a stranger. The visitor only chooses a display name (letters, spaces, hyphens and apostrophes, up to 40 characters) and a title from a fixed list.
- **The password is shown once.** It is generated in `functions/src/functions/demo.js`, sent to Okta in the create call, and returned once in the hire response. The site passes it only to the visitor who started the run, in a `no-store` response. It is never logged and never written to the operations, steps, demo or session tables. Tests check all of this.
- **The person is created in their own group** (`DEMO_OKTA_GROUP_ID`), in the same API call that creates them, so the group's sign-on rules apply from the start.
- **Limits.** Defaults are 3 people at once, 30 a day, and a 5-minute cooldown per visitor IP (in the site). Cleanup runs every minute.

## One-time setup in Okta

Okta's console layout changes, so the menu paths below are approximate. The setting names are the ones to look for.

1. **Create the group.** In Directory > Groups, add a group named something like `Glasscliff demo visitors`. Open it and copy its id (`00g...`) from the address bar.
2. **Assign nothing to the group.** The lifecycle API assigns Expenses to each demo person directly, as it did before. The group exists only so the rules below can target it.
3. **Make sure the group reaches nothing else.**
   - It must not be one of the groups in `OKTA_DOWNSTREAM_GROUP_ID`.
   - It must not be assigned to the Office 365 or Google Workspace apps.
   - No group rule should add `@demo.glasscliff.online` users to other groups.
   - No app should be assigned to Everyone.
   The demo already never asks for Entra ID or Google, but it shouldn't be able to reach them by accident either.
4. **Allow sign-in without MFA, for this group only.**
   - **Global Session Policy** (Security > Global Session Policy): add a policy for the demo group, placed above Default. Add one rule: password as the primary factor, MFA not required, maximum session lifetime 15 minutes.
   - **Expenses authentication policy** (Applications > Glasscliff Expenses > Sign On > User authentication): add a rule at the top. If the user is in the demo group, allow access with any one factor type (password).
   - Expenses uses Federation Broker Mode. I couldn't confirm from Okta's documentation whether an app's authentication policy is evaluated in that mode, which is why both rules are listed. If a test sign-in still asks for MFA, the Global Session Policy rule is the one to check.
5. **Keep demo people out of everything except Expenses.**
   - **Okta Dashboard:** in Security > Authentication Policies > Okta Dashboard, add a rule at the top so the demo group is denied access.
   - **Okta Account Management Policy:** if your org shows this policy, add a rule at the top that denies the demo group. This stops them enrolling factors or recovering the password.
   - **Profile editing:** in Directory > Profile Editor > User (default), check that title, department, first name and last name are read-only for end users. A visitor shouldn't be able to edit their own profile from Okta.
6. **Check the password rules.** In Security > Authenticators > Password, check that no rule applying to the demo group forces a change at first sign-in or expires passwords within minutes. A password set through the API at creation is not marked for change. The generated password is 19 characters with upper case, lower case, digits and hyphens.

## Settings

On the Functions app, either with the CLI:

```bash
az functionapp config appsettings set -g rg-glasscliff-lab -n <function app> --settings \
  DEMO_OKTA_GROUP_ID=00g... DEMO_TTL_MINUTES=8 DEMO_MAX_LIVE=3 DEMO_DAILY_MAX=30
```

or in `main.parameters.json` as `demoOktaGroupId` (with `demoTtlMinutes`, `demoMaxLive` and `demoDailyMax` if you want values other than the new defaults) for the next `main.bicep` deploy. Remember that `main.bicep` rewrites Key Vault secrets on every deploy (see its header), so the CLI is the lighter option.

To switch the demo off without a deploy, set `DEMO_ENABLED=false` on the Functions app. Setting it on the web app as well hides the demo on the page.

## Deploy order

Either order works:

- **New Functions with the old site:** the old page still works, and the password is simply not shown.
- **New site with the old Functions:** the page says sign-ins aren't being handed out, and the demo runs as before, without a session to end.

The CI workflow deploys whichever half changed.

## Test it

Use a private window for the Expenses tab. If your own Okta session for this org is open in the same browser, Okta will sign you in as yourself instead.

1. On the dashboard, create a person with a name and a title.
2. Open Glasscliff Expenses and sign in with the username and password shown. Okta should not ask for MFA.
3. The Expenses page shows the name, title and department you chose.
4. Back on the dashboard, choose Read Expenses again. Sessions should read 1.
5. Choose Change their title. Refresh Expenses: it should show the Senior title and the Operations department, and the check table should show 1 session, unchanged.
6. Choose Offboard them now. The check table should show the account inactive and 0 sessions. The line under it should say Okta's SCIM deactivation call ended 1 session.
7. Refresh the Expenses tab. It should say "Your Expenses account was deactivated". Signing in again at Okta with the same password should fail.
8. With the same username and password, try `https://<your okta org>/app/UserHome`. It should be denied.
9. Within about a minute of the expiry time, the person should no longer be listed in Okta's Directory > People.

After a good run, record the offboarding as a replay:

```bash
LAB_LIFECYCLE_ENDPOINT=https://<function app>.azurewebsites.net/api/lifecycle LAB_OPERATOR_KEY=... \
  node site/tools/record-scenario.js <terminate operationId> --id visitor-session-ended --order 8 \
  --title "A signed-in person is offboarded" \
  --description "A real Expenses sign-in, ended by Okta's SCIM deactivation call. The session count went from 1 to 0 in the same call."
```

Check that the recorded file's SCIM entry shows `sessionsEnded: 1` before you publish it. Once it does, the "session revocation on offboarding" wording on the résumé and the write-ups is backed by evidence.
