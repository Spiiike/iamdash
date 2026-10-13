'use strict';
const { esc } = require('./views');

function aboutPage({ basePath }) {
  return `<section class="hero">
<h1>About this landing zone</h1>
<p>I run Azure and M365 environments, but I usually inherit them. So I wanted to build a small version of it myself to understand things better.</p>
</section>

<section class="section">
<h2>What it is</h2>
<p>An Azure landing zone under my personal subscription (with Platform, Landing Zones, Sandbox and Decommissioned management layers under the primary), policies assigned at the top so everything below inherits them, a central Log Analytics workspace collecting subscription activity log, and a monthly budget with alerts (just in case wild bots decide to try putting me in financial ruin by running up costs.) The Okta identity lab's resources sits within this landing zone group, so it's the first workload run against policies.</p>
<p>This is a simple implementation written in Bicep, not an enterprise-grade solution using the Landing Zone Accelerator.</p>

</section>

<section class="section">
<h2>Audit first, then deny</h2>
<p>The policies in place went in as Audit-only initially to understand the impact before enforcing them. The first scan found 17 problems across 12 resources (every one was a missing tag.)</p>
<p>I tagged the 12 resources, added <code>owner</code> to the lab's Bicep so new resources arrive compliant, rescanned to zero, then switched the policies to Deny.</p>

</section>

<section class="section">
<h2>Things that broke</h2>
<p><strong>The deployment tried to fill in the policy's own blanks.</strong> Policy rules contain expressions like <code>[parameters('effect')]</code> that are meant for Azure Policy to fill in later. My template stored them in variables, and then built a list of them in a loop. Both times, the deployment engine evaluated them itself and failed with <code>The template parameter 'effect' is not found</code>. What-if didn't catch the second one. The fix was to stop being clever: every rule written out in full, directly in the resource.</p>
<p><strong>I created the management groups and then couldn't use them.</strong> Creating management groups needs rights at the top of the tenant, so I elevated, deployed, and removed the elevation. Then the next deployment failed with <code>AuthorizationFailed</code> on the group I'd just made. Azure only makes you Owner of a management group you create if you don't already inherit Owner from above, and while elevated, I did. The fix was to grant Owner on the Glasscliff group explicitly before dropping the elevation.</p>
<p><strong>Tagging a certificate isn't the same as tagging anything else.</strong> <code>az resource tag</code> reads the whole resource, adds the tags and writes the whole thing back. That works for most resources, but the web app's certificate failed with an error about its <code>keyVaultId</code>. <code>az tag update</code> only touches tags and never looks at the rest of the resource, and it worked first time.</p>

</section>

<section class="section">
<h2>What I'd change</h2>
<ul class="prose">
  <li>Separate subscriptions. In an enterprise environment, a landing zone puts logging and other shared services in their own subscriptions. This one has a single subscription, using a resource group as the management unit instead.</li>
  <li>The web app's resource group isn't managed by any of this code. Its tags are correct now, but nothing keeps them that way, and Deny will block any update that drops them.</li>
  <li>Privileged access. JIT elevation through Privileged Identity Management needs an Entra ID P2 license, which this tenant doesn't have... yet.</li>
  <li>Networking. A hub network with a firewall is the expensive part of a landing zone. Why incur costs for no particular reason?</li>
</ul>

<p><a href="${esc(basePath)}/">Back to the live landing zone</a></p>
</section>`;
}

module.exports = { aboutPage };
