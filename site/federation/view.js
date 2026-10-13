'use strict';

// Case study for the Entra ID / Google Cloud Identity half of the identity lab.
// A fragment for the shared page() layout; no data, so nothing to escape.

const federationPage = ({ reconLive = false } = {}) => `
    <section class="hero">
      <h1>One source of truth, two directories.</h1>
      <p>
        The first half of this lab pushes people from Okta into an app I wrote. This half
        points Okta at two directories whose shape I don't control — Microsoft Entra ID
        and Google Cloud Identity — ${reconLive
          ? 'and then checks, twice a day, that all three still agree.'
          : 'and a reconciler, built and tested but not deployed yet, is meant to check that all three still agree.'}
      </p>
      <p class="asof">
        Built and verified 09–12 Oct 2026 · Okta Integrator Free, Entra ID Free, Google Cloud Identity Free
      </p>
    </section>

    <figure class="figure">
      <svg viewBox="0 0 700 420" role="img"
           aria-label="Okta sits at the top as the source of truth. Two arms run downward: one to Entra ID, provisioning over Microsoft Graph and signing in over WS-Federation; one to Google Cloud Identity, provisioning over the Admin SDK and signing in over SAML 2.0. A reconciler reads all three directories and publishes this site's reconciliation page.">
        <defs>
          <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
          </marker>
        </defs>

        <g>
          <rect x="240" y="14" width="200" height="62" rx="2" fill="none" stroke="var(--okta)" stroke-width="1.5"/>
          <text x="340" y="41" text-anchor="middle" font-size="17" fill="var(--paper)" font-family="Georgia,serif">Okta</text>
          <text x="340" y="61" text-anchor="middle" font-size="11" fill="var(--paper-dim)" font-family="'Courier New',monospace">source of truth · MFA gate</text>
        </g>

        <g stroke="var(--rule)" stroke-width="1.5" fill="none" color="var(--rule)">
          <path d="M340 76 L340 100"/>
          <path d="M150 100 L530 100"/>
          <path d="M150 100 L150 128" marker-end="url(#ar)"/>
          <path d="M530 100 L530 128" marker-end="url(#ar)"/>
          <path d="M150 178 L150 204" marker-end="url(#ar)"/>
          <path d="M530 178 L530 204" marker-end="url(#ar)"/>
        </g>

        <g font-family="'Courier New',monospace" font-size="11">
          <text x="150" y="150" text-anchor="middle" fill="var(--ms)">push · Microsoft Graph</text>
          <text x="150" y="166" text-anchor="middle" fill="var(--ms)">sign-in · WS-Federation</text>
          <text x="530" y="150" text-anchor="middle" fill="var(--goog)">push · Admin SDK</text>
          <text x="530" y="166" text-anchor="middle" fill="var(--goog)">sign-in · SAML 2.0</text>
        </g>

        <g>
          <rect x="40" y="208" width="220" height="62" rx="2" fill="none" stroke="var(--ms)" stroke-width="1.5"/>
          <text x="150" y="235" text-anchor="middle" font-size="15" fill="var(--paper)" font-family="Georgia,serif">Entra ID</text>
          <text x="150" y="254" text-anchor="middle" font-size="10.5" fill="var(--paper-dim)" font-family="'Courier New',monospace">domain federated · anchored</text>
        </g>

        <g>
          <rect x="420" y="208" width="220" height="62" rx="2" fill="none" stroke="var(--goog)" stroke-width="1.5"/>
          <text x="530" y="235" text-anchor="middle" font-size="15" fill="var(--paper)" font-family="Georgia,serif">Google Cloud Identity</text>
          <text x="530" y="254" text-anchor="middle" font-size="10.5" fill="var(--paper-dim)" font-family="'Courier New',monospace">SSO profile scoped by OU</text>
        </g>

        <g>
          <rect x="215" y="330" width="250" height="60" rx="2" fill="none" stroke="var(--paper-faint)" stroke-width="1" stroke-dasharray="4 4"/>
          <text x="340" y="356" text-anchor="middle" font-size="14" fill="var(--paper)" font-family="Georgia,serif">Reconciler</text>
          <text x="340" y="375" text-anchor="middle" font-size="10.5" fill="var(--paper-dim)" font-family="'Courier New',monospace">${reconLive ? 'twice daily · read-only · public' : 'built · not deployed yet'}</text>
        </g>

        <g stroke="var(--paper-faint)" stroke-width="1" fill="none" stroke-dasharray="4 4" color="var(--paper-faint)">
          <path d="M150 270 L150 300 L240 300 L240 330" marker-end="url(#ar)"/>
          <path d="M530 270 L530 300 L440 300 L440 330" marker-end="url(#ar)"/>
          <path d="M340 76 L668 76 L668 360 L465 360" marker-end="url(#ar)"/>
        </g>
        <text x="686" y="220" font-size="10" fill="var(--paper-faint)" font-family="'Courier New',monospace"
              transform="rotate(-90 686 220)" text-anchor="middle">reads all three</text>
      </svg>
      <figcaption>
        Two arms, four mechanisms, one checker. Solid lines are provisioning and sign-in;
        dashed lines are the reconciler's read-only pass.
      </figcaption>
    </figure>

    <section class="section">
      <h2>What it does</h2>
      <p>
        Okta owns the account lifecycle and every mapped attribute. Each directory gets two
        separate mechanisms: provisioning out of Okta over that vendor's API, and sign-in
        into the directory with Okta as the identity provider. They're configured
        separately and they fail separately — a working app tile tells you nothing about
        whether federation is on, which is the first thing I got wrong.
      </p>

      <div class="rules">
        <dl>
          <dt>one join key</dt>
          <dd>
            The same lowercase address in all three directories, set before anyone was
            assigned. No rewriting, which is what makes reconciliation an equality check
            rather than a matching algorithm.
          </dd>
          <dt>assignment</dt>
          <dd>
            Each app's sign-on policy denies everyone outside its group outright, so being
            assigned to the app is what grants access to the directory behind it. Both
            require a phishing-resistant second factor.
          </dd>
          <dt>the OU tree</dt>
          <dd>
            Google scopes the SSO profile and the post-SSO challenge by organizational
            unit, which makes the tree infrastructure rather than filing.
          </dd>
          <dt>break-glass</dt>
          <dd>
            One account per tenant, cloud-only, outside every federated path, on a
            different second factor from everything else. Tested before and after each
            federation change.
          </dd>
          <dt>in Terraform</dt>
          <dd>
            Policies and groups, with plan-on-PR and a daily drift job. The vendor
            connectors deliberately are not: they carry authenticated tokens and
            provisioning state no provider models.
          </dd>
        </dl>
      </div>
    </section>

    <section class="section">
      <h2>Three findings worth the build</h2>

      <div class="triptych">
        <article class="panel">
          <span class="path">connector privilege</span>
          <h2>Both connectors can grant admin</h2>
          <p>
            <code>RoleManagement.ReadWrite.Directory</code> in Entra and
            <code>admin.directory.rolemanagement</code> in Google are the same privilege
            under two names, and both vendors ask for it in a four-click setup. A
            compromise of the IdP is a compromise of the directory behind it — on the
            documented path, not through a mistake.
          </p>
        </article>

        <article class="panel">
          <span class="path">opposite defaults</span>
          <h2>One re-challenges, one doesn't</h2>
          <p>
            Entra stops challenging a federated user once the domain is federated. Google
            keeps challenging unless an admin turns it off per OU — and since a
            provisioned user has no Google password, phone or 2-step, that challenge
            can't be satisfied. Same intent, and one of them is a lockout.
          </p>
        </article>

        <article class="panel">
          <span class="path">rollback</span>
          <h2>Removing SSO strands everyone</h2>
          <p>
            Accounts the IdP created carry a password it generated and disclosed to
            nobody. Remove the SSO assignment and those users can't authenticate at all.
            The real rollback is two steps, and the second is an admin password reset per
            user, distributed out of band.
          </p>
        </article>
      </div>
    </section>

    <section class="section">
      <h2>Why there's a reconciler</h2>
      <p>
        Everything above is a point-in-time finding. I verified that deactivation
        propagated to both directories on one afternoon, with five users. That's a demo,
        not a system.
      </p>
      <p>
        So the last piece reads all three directories on a schedule and checks every
        account. It knows the subtle cases: that Okta's status tracks the password
        credential rather than whether someone can sign in, that an Entra account missing
        its anchor looks healthy and cannot be signed into, that break-glass accounts are
        meant to have no Okta identity. If any one of the three reads fails it publishes
        nothing at all, because a partial read would make every account look like it had
        vanished.
      </p>
      ${reconLive
        ? '<p><a href="/labs/identity/recon">See the last reconciliation</a> — read-only, people shown as pseudonyms.</p>'
        : '<p class="muted">The reconciliation page goes live here once the reconciler is deployed.</p>'}
    </section>

  
`;

module.exports = { federationPage };
