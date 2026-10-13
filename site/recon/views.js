'use strict';

/*
 * Rendering for /labs/identity/recon.
 *
 * Server-rendered, like the rest of the site. The page has no client-side
 * fetch: the router has already pulled the snapshot upstream and masked it, so
 * what reaches the browser is final. That is deliberate — it keeps the operator
 * key server-side (same reasoning as dashboard/upstream.js) and means there is
 * exactly one masking pass, in dashboard/mask.js, rather than two schemes.
 */

const { esc } = require('../layout');

const SEVERITY_WORD = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  info: 'note',
};

/** Severity -> the state class the stylesheet colours. */
const SEVERITY_CLASS = {
  critical: 'crit',
  high: 'high',
  medium: 'warn',
  info: 'dim',
};

function relativeTime(iso, now = Date.now()) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const mins = Math.round((now - then) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} minutes ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs === 1 ? 'an hour ago' : `${hrs} hours ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** A directory cell: present/absent, enabled/disabled, plus one qualifier. */
function directoryCell(entry, qualifier, label) {
  const l = ` data-label="${esc(label)}"`;
  if (!entry || !entry.present) {
    return `<td class="dir"${l}><span class="state dim">absent</span></td>`;
  }
  const word = entry.enabled ? 'enabled' : 'disabled';
  const cls = entry.enabled ? 'ok' : 'off';
  const note = qualifier ? `<span class="qual">${esc(qualifier)}</span>` : '';
  return `<td class="dir"${l}><span class="state ${cls}">${word}</span>${note}</td>`;
}

function findingLine(f) {
  const cls = SEVERITY_CLASS[f.severity] || 'dim';
  const word = SEVERITY_WORD[f.severity] || f.severity;
  const ref = f.section ? ` <span class="ref">runbook ${esc(f.section)}</span>` : '';
  return (
    `<li><span class="state ${cls}">${esc(word)}</span>` +
    `<span class="f-text">${esc(f.detail)}` +
    `<span class="rule-id">${esc(f.rule)}${ref}</span></span></li>`
  );
}

function personRows(user) {
  const okta = user.okta
    ? `<span class="state ok">${esc(user.okta.status)}</span><span class="qual">implies ${esc(user.okta.expected)}</span>`
    : `<span class="state dim">no Okta identity</span>`;

  const entraQual = user.entra && user.entra.present
    ? (user.entra.anchored ? 'anchored' : 'no anchor')
    : '';
  const googleQual = user.google && user.google.present ? user.google.orgUnitPath : '';

  // An agreeing row still owes the reader a reason when it looks odd — a
  // directory-native account with no Okta identity, or a STAGED user with no
  // downstream accounts yet. Saying which kind of fine it is costs one word and
  // saves a trip to the legend.
  let verdict;
  if (user.agrees) {
    const rules = new Set((user.findings || []).map((f) => f.rule));
    const word = rules.has('accepted_exception')
      ? 'accepted'
      : rules.has('provisioning_pending')
        ? 'pending'
        : 'agrees';
    verdict = `<span class="state ${word === 'agrees' ? 'ok' : 'dim'}">${word}</span>`;
  } else {
    const worst = SEVERITY_CLASS[user.worst] || 'dim';
    verdict = `<span class="state ${worst}">${esc(SEVERITY_WORD[user.worst] || user.worst)}</span>`;
  }

  const head =
    `<tr class="person${user.agrees ? '' : ' flagged'}">` +
    `<th scope="row"><span class="pid">${esc(user.id)}</span></th>` +
    `<td class="dir" data-label="okta">${okta}</td>` +
    directoryCell(user.entra, entraQual, 'entra') +
    directoryCell(user.google, googleQual, 'google') +
    `<td class="dir" data-label="result">${verdict}</td>` +
    `</tr>`;

  const actionable = (user.findings || []).filter((f) => f.severity !== 'info' || !user.agrees);
  if (!actionable.length) return head;

  return (
    head +
    `<tr class="detail"><td colspan="5"><ul class="findings">` +
    actionable.map(findingLine).join('') +
    `</ul></td></tr>`
  );
}

const DIR_NAME = { okta: 'Okta', entra: 'Entra ID', google: 'Google' };

/** "13 Oct, 18:17 UTC" — short enough for a table cell, unambiguous. */
function shortTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mon = d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${mon}, ${hh}:${mm} UTC`;
}

function span(ms) {
  if (!(ms >= 0)) return '';
  const h = ms / 3600000;
  if (h < 1) return 'under an hour';
  if (h < 48) return `${Math.round(h)} hours`;
  return `${Math.round(h / 24)} days`;
}

const timeTag = (iso) => `<time datetime="${esc(iso)}">${esc(shortTime(iso))}</time>`;

/**
 * Shown under the "Last run" line when the newest attempt is more recent than
 * the published result and failed. Without it, a page that stopped updating
 * looks exactly like a page with nothing to report.
 */
function latestAttemptNote(snapshot) {
  const runs = snapshot.history && snapshot.history.runs;
  if (!runs || !runs.length) return '';
  const newest = runs[0];
  if (newest.outcome !== 'failed') return '';
  if (Date.parse(newest.at) <= Date.parse(snapshot.generatedAt)) return '';
  const which = newest.failedSources && newest.failedSources.length
    ? newest.failedSources.map((d) => DIR_NAME[d] || d).join(' and ')
    : 'one of the directories';
  return `<p class="stale">The latest attempt, at ${timeTag(newest.at)}, couldn't read ${esc(which)}, so it published nothing. What you're seeing is the last complete comparison, not a fresh one.</p>`;
}

function runHistorySection(history) {
  if (!history || !history.runs.length) return '';
  const recent = history.runs.slice(0, 12);
  const complete = history.runs.filter((r) => r.outcome === 'complete').length;
  const failed = history.runs.length - complete;
  const items = recent.map((r) => {
    if (r.outcome === 'complete') {
      const n = r.actionable || 0;
      const what = n === 0 ? 'complete, nothing to resolve' : `complete, ${n} to resolve`;
      return `<li>${timeTag(r.at)} <span class="state ${n ? 'high' : 'ok'}">${esc(what)}</span>${typeof r.durationMs === 'number' ? ` <span class="muted">${(r.durationMs / 1000).toFixed(1)}s</span>` : ''}</li>`;
    }
    const which = r.failedSources && r.failedSources.length ? r.failedSources.map((d) => DIR_NAME[d] || d).join(', ') : 'a directory';
    return `<li>${timeTag(r.at)} <span class="state crit">failed</span> <span class="muted">couldn't read ${esc(which)}; published nothing</span></li>`;
  }).join('');
  return `
    <section class="section">
      <h2>Every run, including the ones that published nothing</h2>
      <p>The last ${history.runs.length} ${history.runs.length === 1 ? 'attempt' : 'attempts'}: ${complete} complete, ${failed} failed. A complete run read all three directories. A failed run couldn't read at least one of them, so it changed nothing on this page and closed no findings.</p>
      <ol class="runlog">${items}</ol>
    </section>`;
}

function findingHistorySection(history, now) {
  if (!history) return '';
  const anyComplete = history.runs.some((r) => r.outcome === 'complete');
  if (!history.findings.length) {
    return anyComplete ? `
    <section class="section">
      <h2>Disagreements over time</h2>
      <p>No complete run in the last 30 days found anything to resolve. Accepted exceptions aren't counted, because they're expected.</p>
    </section>` : '';
  }
  const rows = history.findings.map((f) => {
    const open = !f.resolvedAt;
    const lasted = open ? span(now - Date.parse(f.firstSeen)) : span(Date.parse(f.resolvedAt) - Date.parse(f.firstSeen));
    const who = f.people.map((id) => `<span class="pid">${esc(id)}</span>`).join(' ');
    const status = open
      ? `<span class="state ${SEVERITY_CLASS[f.severity] || 'high'}">open</span>`
      : `<span class="state ok">resolved</span> ${timeTag(f.resolvedAt)}`;
    return `<tr><td>${who}</td><td>${esc(f.detail)} <span class="rule-id">${esc(f.rule)}</span></td><td>${timeTag(f.firstSeen)}</td><td>${timeTag(f.lastSeen)}</td><td class="n">${esc(lasted)}${open ? ' so far' : ''}</td><td>${status}</td></tr>`;
  }).join('');
  return `
    <section class="section">
      <h2>Disagreements over time</h2>
      <p>Each disagreement from first sighting to the complete run that no longer found it. Times are when a run saw it. Runs are twelve hours apart, so a problem may have started up to twelve hours before it was first seen, and been fixed up to twelve hours before it shows as resolved.</p>
      <div class="table-scroll"><table class="table history">
        <thead><tr><th scope="col">Who</th><th scope="col">What</th><th scope="col">First seen</th><th scope="col">Last seen</th><th scope="col" class="n">Lasted</th><th scope="col">Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </section>`;
}

/**
 * The page body. The shell (head, masthead, footer) comes from the site's
 * page() layout, same as every other section.
 *
 * @param {object} snapshot  masked snapshot, ready to publish
 * @param {object} [opts]
 * @param {number} [opts.now]  injected so tests are deterministic
 */
function reconPage(snapshot, opts = {}) {
  const now = opts.now || Date.now();
  const s = snapshot.summary;
  const clean = s.verdict === 'clean';

  const verdictClass = clean ? 'ok' : (SEVERITY_CLASS[s.worst] || 'high');
  const verdictLine = clean
    ? 'All three directories agree'
    : `${s.actionable} ${s.actionable === 1 ? 'disagreement' : 'disagreements'} to resolve`;

  const counts = [
    [s.people, 'accounts seen', 'across all three directories'],
    [s.agreeing, 'in agreement', 'no open findings'],
    [s.actionable, 'to resolve', 'excludes accepted exceptions'],
    [s.accepted, 'accepted', 'break-glass and service accounts'],
  ]
    .map(
      ([v, k, n]) =>
        `<div class="count"><span class="c-v">${esc(v)}</span>` +
        `<span class="c-k">${esc(k)}</span><span class="c-n">${esc(n)}</span></div>`
    )
    .join('');

  const rows = snapshot.users.map(personRows).join('');

  const cross = (snapshot.crossFindings || []).length
    ? `<section class="section">
      <h2>Findings that span more than one account</h2>
      <p>These can't be decided one person at a time. They come from comparing accounts against each other.</p>
      <ul class="findings standalone">${snapshot.crossFindings.map(findingLine).join('')}</ul>
    </section>`
    : '';

  const stale = snapshot.stale
    ? `<p class="stale">The last scheduled run did not finish, so this is the previous result. Nothing is published from a partial read.</p>`
    : '';

  return `
    <section class="hero">
      <h1>Do all three directories still agree?</h1>
      <p>
        Okta owns the account. Entra ID and Google Cloud Identity receive it. Twice a
        day this reads all three and checks, account by account, whether they actually
        say the same thing.
      </p>
      <p class="asof">
        Last run ${esc(relativeTime(snapshot.generatedAt, now))} ·
        <time datetime="${esc(snapshot.generatedAt)}">${esc(new Date(snapshot.generatedAt).toUTCString())}</time>${
          typeof snapshot.durationMs === 'number' ? ` · took ${(snapshot.durationMs / 1000).toFixed(1)}s` : ''
        }
      </p>
      ${stale}
      ${latestAttemptNote(snapshot)}
    </section>

    <p class="verdict"><span class="state ${verdictClass}">${esc(verdictLine)}</span></p>

    <div class="counts">${counts}</div>

    <section class="section">
      <h2>Account by account</h2>
      <p>
        Disagreements first. The Okta column shows the status Okta holds and the
        downstream state that status implies, which is not the same thing — Okta's
        status tracks the password credential, not whether the person can sign in.
      </p>

      <table class="ledger">
        <caption>One row per account found in any directory.</caption>
        <thead>
          <tr>
            <th scope="col">Person</th>
            <th scope="col">Okta</th>
            <th scope="col">Entra ID</th>
            <th scope="col">Google</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>

    ${cross}

    ${findingHistorySection(snapshot.history, now)}

    ${runHistorySection(snapshot.history)}

    <section class="section">
      <h2>How to read this</h2>
      <div class="rules">
        <dl>
          <dt>pseudonyms</dt>
          <dd>
            People are stable fake labels, the same ones the operations dashboard uses,
            so one person can be followed across both pages. Addresses, directory object
            ids and attribute values are never published.
          </dd>
          <dt>accepted</dt>
          <dd>
            Break-glass and the provisioning connector's own service account are meant to
            exist with no Okta identity. They're recorded as exceptions rather than
            reported as faults, because a check that cries wolf gets ignored.
          </dd>
          <dt>anchored</dt>
          <dd>
            Entra matches a federated sign-in on an immutable anchor Okta writes. An
            account without one looks healthy in the portal and cannot be signed into.
          </dd>
          <dt>clean</dt>
          <dd>
            The most recent complete run found nothing to resolve. It is not a claim about
            any time after that run. If a later attempt failed, the note under "Last run"
            says so, and the run list below shows it.
          </dd>
          <dt>if a read fails</dt>
          <dd>
            Nothing is published. A partial read would make every account look like it
            had vanished from a directory, so the run stops and this page keeps the
            previous result and its timestamp.
          </dd>
        </dl>
      </div>
    </section>`;
}

/** Shown when the reconciler has never produced a snapshot. */
function emptyPage() {
  return `
    <section class="hero">
      <h1>No reconciliation to show yet.</h1>
      <p>
        The scheduled run publishes twice a day. If this persists, the last run stopped
        before publishing — which is what it should do when one of the three directories
        can't be read, rather than show an incomplete comparison.
      </p>
    </section>`;
}

// Shown instead of the reconciliation when no reconciler is configured at all.
// Different from emptyPage(): that one means "it runs, but has nothing to show".
function notDeployedPage() {
  return `
    <section class="hero">
      <h1>The reconciler isn't deployed yet.</h1>
      <p>
        It is built and tested: it reads Okta, Entra ID and Google Cloud Identity, and
        publishes nothing at all if any one of the three can't be read. It just isn't
        running anywhere yet, so there is no reconciliation to show. This page will fill in
        once it is.
      </p>
      <p class="byline"><a href="/labs/identity/federation">How the three directories are wired</a></p>
    </section>`;
}

module.exports = { reconPage, emptyPage, notDeployedPage, relativeTime, shortTime };
