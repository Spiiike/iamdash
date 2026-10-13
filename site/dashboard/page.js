'use strict';
// The dashboard page. All data is inserted with textContent / SVG attributes,
// never innerHTML, because some of it originates in Okta.

// Only what is particular to this page. The base look (navy field, type, links,
// buttons, hairlines) comes from the shared /labs/assets/glasscliff.css.
const CSS = `
.wrap.wide{max-width:1120px}
.try{border-top:1px solid var(--rule);border-bottom:1px solid var(--rule);padding:18px 0 20px;margin:30px 0 0;max-width:var(--measure)}
.try h2{margin:0 0 8px;font:400 21px/1.25 Georgia,serif}
.try p{margin:0 0 14px;color:var(--paper-dim);font-size:15px}
.try .row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.try .note{margin:12px 0 0;color:var(--paper-faint);font-size:14px}
.tabs{display:flex;gap:22px;margin:clamp(30px,5vw,46px) 0 22px;border-bottom:1px solid var(--rule)}
.tabs button{font:13px/1 'Courier New',monospace;letter-spacing:.04em;border:0;border-bottom:2px solid transparent;margin-bottom:-1px;padding:0 0 12px;background:transparent;color:var(--paper-faint);cursor:pointer;border-radius:0}
.tabs button:hover:not([disabled]){color:var(--live)}
.tabs button[aria-selected="true"]{color:var(--paper);border-bottom-color:var(--paper)}
.tabs button[disabled]{opacity:.4;cursor:default}
button:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--live);outline-offset:3px}
.layout{display:grid;grid-template-columns:17rem minmax(0,1fr);gap:clamp(24px,4vw,48px);align-items:start}
@media (max-width:52rem){.layout{grid-template-columns:1fr}}
.runs{list-style:none;margin:0;padding:0;border-top:1px solid var(--rule)}
.runs li{border-bottom:1px solid var(--rule-soft)}
.runs button{all:unset;box-sizing:border-box;display:grid;grid-template-columns:auto 1fr;gap:2px 12px;width:100%;padding:12px 8px 12px 0;cursor:pointer;color:var(--paper-dim)}
.runs button:hover{color:var(--paper)}
.runs button:focus-visible{outline:2px solid var(--live);outline-offset:-2px}
.runs button[aria-current="true"]{color:var(--paper);box-shadow:inset 2px 0 0 var(--paper);padding-left:12px}
.runs .kind{font:15px/1.5 Georgia,serif}
.runs .who{grid-column:1/-1;color:var(--paper-faint);font:12px/1.6 'Courier New',monospace;padding-left:20px}
.dot{width:8px;height:8px;margin-top:8px;background:var(--paper-faint)}
.dot.succeeded{background:var(--live)}.dot.failed{background:var(--crit)}.dot.awaiting_scim,.dot.running,.dot.pending{background:var(--warn)}
.note-row{color:var(--paper-faint);font-size:14px;padding:12px 0}
.note-row button{font:inherit;color:var(--paper);text-decoration:underline;text-underline-offset:3px;background:none;border:0;padding:0;cursor:pointer}
.detail{min-width:0;border-top:1px solid var(--rule);padding:22px 0 0}
.nowrap{white-space:nowrap}
.detail h2{font:400 clamp(24px,3vw,32px)/1.2 Georgia,serif;letter-spacing:-.01em;margin:0 0 10px}
.facts{display:flex;flex-wrap:wrap;gap:4px 22px;margin:0 0 14px;font:12px/1.8 'Courier New',monospace;color:var(--paper-faint)}
.status{letter-spacing:.06em}
.status.succeeded{color:var(--live)}.status.failed{color:var(--crit)}.status.awaiting_scim,.status.running,.status.pending{color:var(--warn)}
.summary{margin:0 0 20px;max-width:62ch;color:var(--paper-dim)}
.lanebox{overflow-x:auto;margin:0 0 16px;padding:0}
svg.lanes{display:block;width:100%;height:auto}
.lanes text{font:12px 'Courier New',monospace;fill:var(--paper-faint)}
.lanes .lane-label{fill:var(--paper)}
.lanes .tick{stroke:var(--rule-soft)}
.lanes .laneline{stroke:var(--rule)}
.f-okta{fill:var(--okta)}.f-app{fill:var(--live)}.f-entra{fill:var(--ms)}.f-google{fill:var(--goog)}.f-api{fill:var(--paper-dim)}.f-bad{fill:var(--crit)}
.f-pending{fill:var(--warn)}
.lanes .item{opacity:1;transition:opacity .25s}
.lanes .item.hidden{opacity:0}
.lanes .playhead{stroke:var(--paper);stroke-width:1.5}
.lanes .ended text{fill:var(--crit)}
.controls{display:flex;gap:16px;align-items:center;margin:0 0 22px}
.clock{font:12px 'Courier New',monospace;color:var(--paper-faint)}
ol.steps{list-style:none;margin:0;padding:0}
ol.steps li{display:grid;grid-template-columns:5rem 7rem 1fr;gap:3px 16px;padding:11px 0;border-top:1px solid var(--rule-soft)}
ol.steps li.hidden{display:none}
@media (max-width:36rem){ol.steps li{grid-template-columns:4rem 1fr}ol.steps .lane{grid-column:2}ol.steps .what{grid-column:1/-1}}
.t{font:12px/1.8 'Courier New',monospace;color:var(--paper-faint)}
.lane{font:12px/1.8 'Courier New',monospace;letter-spacing:.04em}
.lane.api{color:var(--paper-dim)}.lane.okta{color:var(--okta)}.lane.app{color:var(--live)}.lane.entra{color:var(--ms)}.lane.google{color:var(--goog)}
.what .o-pending{color:var(--warn)}
.what b{font-weight:400;color:var(--paper)}
.what .d{display:block;color:var(--paper-faint);font-size:14px}
.what .o-failed,.what .ended{color:var(--crit)}
.prov{display:inline-block;font:11px/1.5 'Courier New',monospace;letter-spacing:.08em;padding:0 6px;border:1px solid currentColor}
.prov.live,.prov.recorded{color:var(--live)}.prov.illustrative,.prov.unlabelled{color:var(--warn)}
.provnote{margin:-8px 0 18px;color:var(--paper-faint);font-size:14px;max-width:62ch}
.kind{display:block;font:11px/1.6 'Courier New',monospace;letter-spacing:.06em;color:var(--paper-faint)}
.proof{margin:26px 0 0;padding:16px 0 0;border-top:1px solid var(--rule);max-width:70ch}
.proof h3{margin:0 0 8px;font:400 17px/1.3 Georgia,serif}
.proof dl{display:grid;grid-template-columns:9rem 1fr;gap:6px 16px;margin:0;font-size:14px;color:var(--paper-dim)}
.proof dt{font:12px/1.7 'Courier New',monospace;color:var(--paper)}
.proof dd{margin:0}
@media (max-width:36rem){.proof dl{grid-template-columns:1fr}.proof dd{margin-bottom:6px}}
.check{margin:16px 0 0;max-width:var(--measure)}
.check h3{margin:0 0 6px;font:400 17px/1.3 Georgia,serif}
.check p{margin:0 0 10px;font-size:14px;color:var(--paper-faint)}
.check table{width:100%;border-collapse:collapse;font-size:14px}
.check th,.check td{text-align:left;padding:7px 12px 7px 0;border-bottom:1px solid var(--rule-soft);vertical-align:baseline;color:var(--paper-dim)}
.check thead th{font:11px/1.4 'Courier New',monospace;letter-spacing:.08em;color:var(--paper-faint);border-bottom:1px solid var(--rule)}
.check td.v-ok{color:var(--live)}.check td.v-bad{color:var(--crit)}.check td.v-na{color:var(--paper-faint)}
.check .raw{font:12px 'Courier New',monospace}
.checkwrap{overflow-x:auto}
.empty h2{margin-top:0}
.empty p{color:var(--paper-dim)}
@media (prefers-reduced-motion:reduce){.lanes .item{transition:none}}
`;

// Client code. Runs in the browser; no data is ever parsed as HTML.
const CLIENT = String.raw`
(() => {
  const BASE = document.body.dataset.base;
  const LIVE = document.body.dataset.live === 'true';
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    for (const k of kids) if (k !== null && k !== undefined) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };
  const SVG = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs = {}, text) => {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const KIND = { hire: 'Joiner', transfer: 'Role change', terminate: 'Leaver' };
  const STATUS = { succeeded: 'Succeeded', failed: 'Failed', awaiting_scim: 'Waiting for Okta', running: 'Running', pending: 'Pending' };
  // Entra ID and Google only appear for runs that reached them, so an
  // Expenses-only run keeps its three lanes.
  const LANES = [
    { key: 'okta', name: 'Okta' },
    { key: 'app', name: 'Expenses' },
    { key: 'entra', name: 'Entra ID', optional: true },
    { key: 'google', name: 'Google', optional: true },
    { key: 'api', name: 'Lab checks' },
  ];
  const LANE_NAME = Object.fromEntries(LANES.map((l) => [l.key, l.name]));
  const WHAT = {
    'okta.lookup': 'Look up the person in Okta',
    'okta.createUser': 'Create their Okta account',
    'okta.assignExpenses': 'Assign them the Expenses app',
    'okta.updateProfile': 'Update their Okta profile',
    'okta.clearSessions': 'End Okta sessions and revoke tokens',
    'okta.deactivate': 'Deactivate them in Okta',
    'verify.expensesAccountCreated': 'Check the Expenses account exists',
    'verify.expensesAccountUpdated': 'Check Expenses received the change',
    'verify.expensesAccountDisabled': 'Check the Expenses account is deactivated',
    'verify.expensesSessionsEnded': 'Check no Expenses sessions remain',
    'verify.recheck': 'Recheck when the status was requested',
    'okta.assignEntra': 'Assign them the Office 365 app',
    'okta.assignGoogle': 'Assign them the Google Workspace app',
    'okta.addToGroup': 'Add them to the group that carries Entra ID and Google',
    'verify.entraAccountCreated': 'Check the account landed in Entra ID',
    'verify.entraAccountUpdated': 'Check Entra ID received the change',
    'verify.entraAccountDisabled': 'Check the Entra ID account is disabled',
    'verify.googleAccountCreated': 'Check the account landed in Google',
    'verify.googleAccountUpdated': 'Check Google received the change',
    'verify.googleAccountSuspended': 'Check the Google account is suspended',
    'scim.listUsers': 'Okta asks Expenses whether the account exists',
    'scim.getUser': 'Okta reads the Expenses account',
    'scim.createUser': 'Okta creates the Expenses account',
    'scim.replaceUser': 'Okta updates the Expenses account',
    'scim.patchUser': 'Okta changes the Expenses account',
    'scim.deleteUser': 'Okta deletes the Expenses account',
  };
  // A verify.entra* bar sits on the Entra ID lane and ends when the account was
  // seen there: the lab can't watch Okta's push to Entra or Google arrive the way
  // the SCIM endpoint sees its own, so the arrival is when the check confirmed it.
  // What each event is evidence of. The same three layers the "What each step
  // proves" key explains under the timeline.
  const KIND_OF = (name) =>
    name.startsWith('okta.') ? 'Okta API call'
    : name.startsWith('scim.') ? 'Received by Expenses'
    : name.startsWith('verify.') ? 'Readback'
    : 'Lab step';
  const laneOf = (step) =>
    step.startsWith('okta.') ? 'okta'
    : step.startsWith('scim.') ? 'app'
    : step.startsWith('verify.entra') ? 'entra'
    : step.startsWith('verify.google') ? 'google'
    : 'api';

  const state = { mode: LIVE ? 'live' : 'replay', selected: null, op: null, timer: null, anim: null };

  // ---------- data --------------------------------------------------------
  async function api(path) {
    const res = await fetch(BASE + path, { headers: { accept: 'application/json' } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'The dashboard could not load that.');
    return body;
  }

  // Merge steps and SCIM calls into one time-ordered list of events.
  function events(op) {
    const t0 = Date.parse(op.created);
    const out = [];
    for (const s of op.steps || []) {
      if (!s.started) continue;
      out.push({ lane: laneOf(s.step), name: s.step, start: Date.parse(s.started) - t0, dur: s.durationMs || 0, outcome: s.outcome, detail: s.detail });
    }
    for (const c of op.scim || []) {
      if (!c.at) continue;
      out.push({ lane: 'app', name: c.step, start: Date.parse(c.at) - t0, dur: 0, outcome: c.outcome, http: c.httpStatus, ended: c.sessionsEnded || 0, point: true });
    }
    return out.sort((a, b) => a.start - b.start);
  }

  const PROV = {
    live: ['Live', 'A run against the lab\'s Okta org, read from the lifecycle API as it happens.'],
    recorded: ['Recorded run', 'Captured from a real run by tools/record-scenario.js. The person is replaced by a placeholder; the steps and timings are as they happened.'],
    illustrative: ['Illustrative', 'The steps follow the lab\'s real flow, but the timings were written by hand. Not a recording.'],
    unlabelled: ['Unlabelled', 'This replay does not say where it came from, so treat it as illustrative.'],
  };
  const provText = (p) => {
    if (!p) return PROV.unlabelled[0];
    const [label] = PROV[p.kind] || PROV.unlabelled;
    return p.kind === 'recorded' && p.capturedAt ? label + ', ' + new Date(p.capturedAt + 'T12:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : label;
  };
  const secs = (ms) => (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + ' s';
  const ago = (iso) => {
    const diff = (Date.parse(iso) - Date.now()) / 1000;
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    for (const [unit, n] of [['day', 86400], ['hour', 3600], ['minute', 60]]) if (Math.abs(diff) >= n) return rtf.format(Math.round(diff / n), unit);
    return 'just now';
  };

  // ---------- list --------------------------------------------------------
  async function showList() {
    const box = $('#runs');
    box.replaceChildren();
    clearTimeout(state.timer);
    try {
      if (state.mode === 'live') {
        const { operations } = await api('/api/operations');
        if (!operations.length) {
          box.append(el('li', {}, el('p', { class: 'note-row' }, 'No live runs yet. Runs appear here when an operator hires, moves or offboards someone. ', el('button', { onclick: () => setMode('replay') }, 'Watch a replay instead'), '.')));
          renderEmpty();
        } else {
          for (const op of operations) box.append(runItem(op.operationId, KIND[op.type] || 'Run', (op.person || 'someone') + ', ' + ago(op.created), op.status));
          if (!state.selected || !operations.some((o) => o.operationId === state.selected)) select(operations[0].operationId);
          else markCurrent();
        }
        state.timer = setTimeout(showList, 15000);
      } else {
        const { scenarios } = await api('/api/scenarios');
        for (const s of scenarios) box.append(runItem(s.id, s.title, provText(s.provenance), s.status || 'succeeded'));
        if (!state.selected || !scenarios.some((s) => s.id === state.selected)) select(scenarios[scenarios.length - 1].id);
        else markCurrent();
      }
    } catch (err) {
      const p = el('p', { class: 'note-row' }, err.message);
      if (state.mode === 'live') p.append(' ', el('button', { onclick: () => setMode('replay') }, 'Watch a replay'), '.');
      box.append(el('li', {}, p));
      $('#detail').replaceChildren(el('p', {}, err.message));
    }
  }

  function runItem(id, kind, who, status) {
    return el('li', {}, el('button', { 'data-id': id, onclick: () => select(id) },
      el('span', { class: 'dot ' + status, 'aria-hidden': 'true' }), el('span', { class: 'kind' }, kind), el('span', { class: 'who' }, who)));
  }
  function markCurrent() {
    for (const b of document.querySelectorAll('#runs button')) b.setAttribute('aria-current', String(b.dataset.id === state.selected));
  }

  // ---------- detail ------------------------------------------------------
  async function select(id) {
    state.selected = id;
    markCurrent();
    stopAnim();
    try {
      let op, title, description, provenance, replay = state.mode === 'replay';
      if (replay) {
        const s = await api('/api/scenarios/' + encodeURIComponent(id));
        op = s.operation; title = s.title; description = s.description; provenance = s.provenance;
      } else {
        op = await api('/api/operations/' + encodeURIComponent(id));
      }
      if (state.selected !== id) return;
      state.op = op;
      renderDetail(op, { title, description, replay, provenance });
      if (replay && !REDUCED) play();
      if (!replay && !['succeeded', 'failed'].includes(op.status)) setTimeout(() => state.selected === id && state.mode === 'live' && select(id), 3000);
    } catch (err) {
      $('#detail').replaceChildren(el('p', {}, err.message));
    }
  }

  function renderEmpty() {
    $('#detail').replaceChildren(el('div', { class: 'empty' },
      el('h2', {}, 'Nothing has run yet'),
      el('p', {}, 'Replays show the same timeline using runs recorded in this lab.'),
      el('button', { class: 'btn', onclick: () => setMode('replay') }, 'Watch a replay')));
  }

  function renderDetail(op, { title, description, replay, provenance }) {
    const ev = events(op);
    const end = Math.max(Date.parse(op.updated) - Date.parse(op.created) || 0, ...ev.map((e) => e.start + e.dur), 1000);
    const heading = replay ? title : el('span', {}, (KIND[op.type] || 'Run') + ': ', el('span', { class: 'nowrap' }, op.person || 'someone'));
    const pkind = replay ? ((provenance && PROV[provenance.kind]) ? provenance.kind : 'unlabelled') : 'live';
    const facts = el('p', { class: 'facts' },
      el('span', { class: 'prov ' + pkind }, replay ? provText(provenance) : 'Live'),
      el('span', { class: 'status ' + op.status }, STATUS[op.status] || op.status),
      el('span', {}, 'Took ' + secs(end)),
      replay ? null : el('span', {}, 'Started ' + ago(op.created)));
    const provNote = el('p', { class: 'provnote' }, (PROV[pkind] || PROV.unlabelled)[1] + (replay && provenance && provenance.note ? ' ' + provenance.note : ''));
    const summary = el('p', { class: 'summary' }, replay ? description : (op.summary || ''));
    if (op.error) summary.append(el('span', { class: 'd' }, ' ' + op.error));

    const clock = el('span', { class: 'clock' });
    const btn = el('button', { class: 'btn', onclick: () => play() }, 'Replay at real speed');
    $('#detail').replaceChildren(
      el('h2', {}, heading), facts, provNote, summary,
      el('div', { class: 'lanebox' }, lanes(ev, end, op)),
      el('div', { class: 'controls' }, btn, clock),
      stepList(ev), proofKey());
    state.controls = { btn, clock, end };
  }

  function lanes(ev, end, op) {
    // Drawn at the container's real width so text stays full size on phones.
    const shown = LANES.filter((l) => !l.optional || ev.some((e) => e.lane === l.key));
    const W = Math.max(300, Math.round($('#detail').clientWidth)), LEFT = W < 480 ? 78 : 108, RIGHT = 14, LANE = shown.length > 3 ? 40 : 46, TOP = 12, H = TOP + shown.length * LANE + 30;
    const x = (ms) => LEFT + (ms / end) * (W - LEFT - RIGHT);
    const svg = sv('svg', { class: 'lanes', viewBox: '0 0 ' + W + ' ' + H, role: 'img',
      'aria-label': 'Timeline of ' + ev.length + ' events over ' + secs(end) + '. The same events are listed below.' });
    // Tick spacing scales with the run: a 7 s Expenses run and a 40 s run that
    // waits on Entra ID both get a readable axis.
    const maxTicks = W < 480 ? 6 : 12;
    const step = [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000].find((s) => end / s <= maxTicks) || 300000;
    for (let t = 0; t <= end; t += step) {
      svg.append(sv('line', { class: 'tick', x1: x(t), x2: x(t), y1: TOP - 4, y2: TOP + shown.length * LANE }));
      svg.append(sv('text', { x: x(t), y: H - 8, 'text-anchor': 'middle' }, t >= 60000 && t % 60000 === 0 ? (t / 60000) + ' min' : (t / 1000) + ' s'));
    }
    shown.forEach((lane, i) => {
      const y = TOP + i * LANE + LANE / 2;
      svg.append(sv('text', { class: 'lane-label', x: 0, y: y + 4 }, lane.name));
      svg.append(sv('line', { class: 'laneline', x1: LEFT, x2: W - RIGHT, y1: y, y2: y }));
    });
    for (const e of ev) {
      const i = shown.findIndex((l) => l.key === e.lane);
      const y = TOP + i * LANE + LANE / 2;
      const g = sv('g', { class: 'item' + (e.ended ? ' ended' : ''), 'data-t': e.start });
      const fill = e.outcome === 'failed' ? 'f-bad' : e.outcome === 'pending' ? 'f-pending' : 'f-' + e.lane;
      if (e.point) {
        const cx = x(e.start);
        g.append(sv('path', { class: fill, d: 'M' + cx + ' ' + (y - 9) + 'l9 9-9 9-9-9z' }));
        if (e.ended) {
          const roomRight = cx + 13 + 100 < W - RIGHT; // label is about 95 px wide
          g.append(sv('text', { x: roomRight ? cx + 13 : cx - 13, y: y - 11, 'text-anchor': roomRight ? 'start' : 'end' }, 'Session ended'));
        }
      } else {
        const r = sv('rect', { class: fill, x: x(e.start), y: y - 7, width: Math.max(3, x(e.start + e.dur) - x(e.start)), height: 14 });
        r.dataset.start = e.start; r.dataset.dur = e.dur;
        g.append(r);
      }
      const t = sv('title', {}, (WHAT[e.name] || e.name) + ' at ' + secs(e.start));
      g.append(t);
      svg.append(g);
    }
    const ph = sv('line', { class: 'playhead', x1: LEFT, x2: LEFT, y1: TOP - 6, y2: TOP + shown.length * LANE, visibility: 'hidden' });
    svg.append(ph);
    state.lanes = { x, ph };
    return svg;
  }

  function stepList(ev) {
    const ol = el('ol', { class: 'steps', 'aria-label': 'Events in order' });
    for (const e of ev) {
      const what = el('span', { class: 'what' }, el('b', {}, WHAT[e.name] || e.name));
      if (e.outcome === 'failed') what.append(' ', el('span', { class: 'o-failed' }, 'failed'));
      if (e.outcome === 'skipped') what.append(' (skipped)');
      if (e.outcome === 'pending') what.append(' ', el('span', { class: 'o-pending' }, 'not confirmed in time'));
      if (e.ended) what.append(' ', el('span', { class: 'ended' }, e.ended === 1 ? 'and ended 1 open session' : 'and ended ' + e.ended + ' open sessions'));
      const d = e.detail || (e.http ? 'HTTP ' + e.http : '');
      if (d) what.append(el('span', { class: 'd' }, d + (e.dur ? ' (' + secs(e.dur) + ')' : '')));
      what.prepend(el('span', { class: 'kind' }, KIND_OF(e.name)));
      ol.append(el('li', { 'data-t': e.start }, el('span', { class: 't' }, '+' + secs(e.start)), el('span', { class: 'lane ' + e.lane }, LANE_NAME[e.lane]), what));
    }
    return ol;
  }

  // What each kind of step can and cannot prove. A 200 from an API is not the
  // same claim as the downstream system holding the change.
  function proofKey() {
    const row = (k, v) => [el('dt', {}, k), el('dd', {}, v)];
    return el('section', { class: 'proof', 'aria-label': 'What each step proves' },
      el('h3', {}, 'What each kind of step proves'),
      el('dl', {},
        ...row('Okta API call', 'The lab asked Okta to do something and Okta accepted it. On its own, that proves nothing reached any app.'),
        ...row('Received by Expenses', 'The Expenses SCIM endpoint logged Okta\'s call when it arrived. This proves Okta pushed the change, and when.'),
        ...row('Readback', 'The target was read afterwards to confirm it holds the intended state: the account exists, the title changed, the account is inactive, no session is left.'),
        ...row('Check it yourself', 'For runs you start yourself under "Run one yourself", this page also reads Expenses directly, without going through the lifecycle API. You can open that read in another tab.')));
  }

  // ---------- playback: events appear at their real offsets -----------------
  function stopAnim() {
    if (state.anim) cancelAnimationFrame(state.anim);
    state.anim = null;
  }
  function play() {
    if (!state.controls) return;
    stopAnim();
    const { btn, clock, end } = state.controls;
    const items = [...document.querySelectorAll('#detail [data-t]')];
    const bars = [...document.querySelectorAll('#detail rect[data-dur]')];
    if (REDUCED) { items.forEach((n) => n.classList.remove('hidden')); return; }
    items.forEach((n) => n.classList.add('hidden'));
    btn.disabled = true;
    state.lanes.ph.setAttribute('visibility', 'visible');
    const t0 = performance.now();
    const tick = (now) => {
      const t = Math.min(now - t0, end);
      for (const n of items) if (Number(n.dataset.t) <= t) n.classList.remove('hidden');
      for (const r of bars) {
        const s0 = Number(r.dataset.start), until = Math.min(t, s0 + Number(r.dataset.dur));
        r.setAttribute('width', Math.max(3, state.lanes.x(until) - state.lanes.x(s0)));
      }
      const px = state.lanes.x(t);
      state.lanes.ph.setAttribute('x1', px); state.lanes.ph.setAttribute('x2', px);
      clock.textContent = secs(t);
      if (t < end) state.anim = requestAnimationFrame(tick);
      else { btn.disabled = false; clock.textContent = 'Done in ' + secs(end); state.lanes.ph.setAttribute('visibility', 'hidden'); state.anim = null; }
    };
    state.anim = requestAnimationFrame(tick);
  }

  // Redraw the timeline at the new width when the window is resized.
  let resizeTimer;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const box = document.querySelector('#detail .lanebox');
      if (!box || !state.op || state.anim) return;
      box.replaceChildren(lanes(events(state.op), state.controls.end, state.op));
    }, 150);
  });

  // ---------- run one yourself --------------------------------------------
  const demo = { runKey: null, expiresAt: null, live: false, busy: false };

  async function send(path, body) {
    const res = await fetch(BASE + path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || 'That did not work. Try again in a minute.');
    return out;
  }

  function demoNote(text) { $('#try-note').textContent = text || ''; }

  // Independent readback: this site reading Expenses' own tables, not the
  // lifecycle API's account of what it did.
  const stateUrl = () => BASE + '/api/demo/state?run=' + encodeURIComponent(demo.runKey);
  async function readState() {
    if (!demo.runKey) return null;
    const res = await fetch(stateUrl(), { headers: { accept: 'application/json' } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'The Expenses database could not be read.');
    return body;
  }

  const acct = (st) => !st ? '—' : !st.account.exists ? 'absent' : st.account.active ? 'exists, active' : 'exists, inactive';
  const sess = (st) => !st ? '—' : st.sessions.total + (st.sessions.simulated ? ' (' + st.sessions.simulated + ' simulated)' : '');
  const val = (st, k) => !st || !st.account.exists ? '—' : (st.account[k] || '(empty)');

  // [what, before, expected, observed, verdict: true | false | null]
  function expectations(kind, b, a) {
    if (kind === 'hire') return [
      ['Expenses account', 'did not exist', 'exists, active', acct(a), !!a && a.account.exists && a.account.active],
      ['Title', '—', 'set from Okta', val(a, 'title'), !!a && a.account.exists && !!a.account.title],
      ['Department', '—', 'set from Okta', val(a, 'department'), !!a && a.account.exists && !!a.account.department],
      ['Session rows', '0', 'at least 1 (simulated)', sess(a), !!a && a.sessions.total >= 1],
    ];
    if (kind === 'move') return [
      ['Expenses account', acct(b), 'still active', acct(a), !!a && a.account.exists && a.account.active],
      ['Title', val(b, 'title'), 'changed', val(a, 'title'), !!a && !!b && a.account.exists && a.account.title !== b.account.title],
      ['Department', val(b, 'department'), 'changed', val(a, 'department'), !!a && !!b && a.account.exists && a.account.department !== b.account.department],
    ];
    return [
      ['Expenses account', acct(b), 'inactive or removed', acct(a), !!a && (!a.account.exists || !a.account.active)],
      ['Session rows', sess(b), '0', sess(a), !!a && a.sessions.total === 0],
    ];
  }

  function renderCheck(kind, before, after, err) {
    const box = $('#check');
    box.hidden = false;
    if (err) { box.replaceChildren(el('h3', {}, 'Check it yourself'), el('p', {}, err)); return; }
    const rows = expectations(kind, before, after).map(([what, b, x, o, ok]) =>
      el('tr', {}, el('th', { scope: 'row' }, what), el('td', {}, b), el('td', {}, x), el('td', {}, o),
        el('td', { class: ok === true ? 'v-ok' : ok === false ? 'v-bad' : 'v-na' }, ok === true ? 'matches' : ok === false ? 'does not match' : 'n/a')));
    const allOk = expectations(kind, before, after).every((r) => r[4] !== false);
    box.replaceChildren(
      el('h3', {}, 'Check it yourself'),
      el('p', {}, after.source + ' Read at ' + new Date(after.readAt).toLocaleTimeString() + '. ' +
        (allOk ? 'Everything the run claimed is what Expenses holds.' : 'At least one value is not what the run claimed. Expenses may still be catching up: refresh the raw read below.')),
      el('div', { class: 'checkwrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Expenses holds'), el('th', {}, 'Before'), el('th', {}, 'Expected'), el('th', {}, 'Observed'), el('th', {}, ''))),
        el('tbody', {}, ...rows))),
      el('p', {}, 'The session at hire is simulated, because nobody signs in as a demo person. What happens to it afterwards is real: Okta\'s SCIM deactivation deletes it. ',
        el('a', { class: 'raw', href: stateUrl(), target: '_blank', rel: 'noopener' }, 'Open the raw read'), ' and refresh it as often as you like.'));
  }

  function expiryText() {
    if (!demo.expiresAt) return '';
    const mins = Math.max(0, Math.round((Date.parse(demo.expiresAt) - Date.now()) / 60000));
    return mins ? 'This person is deleted automatically in about ' + mins + (mins === 1 ? ' minute.' : ' minutes.') : 'This person is being deleted now.';
  }

  function demoButtons(buttons) {
    const row = $('#try-row');
    row.replaceChildren();
    for (const b of buttons) row.append(el('button', { class: 'btn' + (b[2] ? ' quiet' : ''), onclick: b[1] }, b[0]));
  }

  async function demoAct(path, label, after, kind) {
    if (demo.busy) return;
    demo.busy = true;
    const row = $('#try-row');
    for (const b of row.querySelectorAll('button')) b.disabled = true;
    demoNote(label);
    let before = null;
    try { before = await readState(); } catch { before = null; }
    try {
      const out = await send(path, demo.runKey ? { runKey: demo.runKey } : {});
      if (out.runKey) { demo.runKey = out.runKey; demo.expiresAt = out.expiresAt; }
      readState().then((a) => renderCheck(kind, before, a)).catch((e) => renderCheck(kind, before, null, e.message));
      state.mode = 'live';
      for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.mode === 'live'));
      state.op = out.operation;
      state.selected = out.operation.operationId;
      renderDetail(out.operation, { replay: false });
      showList();
      after();
    } catch (err) {
      demoNote(err.message);
      for (const b of row.querySelectorAll('button')) b.disabled = false;
    } finally {
      demo.busy = false;
    }
  }

  const startButton = () => demoButtons([['Hire someone', () => demoAct('/api/demo/start', 'Creating them in Okta and waiting for Expenses…', () => {
    demo.live = true;
    demoButtons([['Move them to a new role', moveThem], ['Offboard them', offboardThem, true]]);
    demoNote(expiryText());
  }, 'hire')]]);

  const moveThem = () => demoAct('/api/demo/move', 'Updating Okta and waiting for the change to reach Expenses…', () => {
    demoButtons([['Offboard them', offboardThem]]);
    demoNote(expiryText());
  }, 'move');

  const offboardThem = () => demoAct('/api/demo/offboard', 'Revoking their access and ending their Expenses session…', () => {
    demo.live = false;
    demoButtons([['Start another', () => { demo.runKey = null; demo.expiresAt = null; $('#check').hidden = true; startButton(); demoNote(''); }]]);
    demoNote('Okta deactivated them, and its SCIM call ended their Expenses session. The account is deleted shortly.');
  }, 'offboard');

  async function setUpDemo() {
    if (!LIVE) return;
    try {
      const limits = await (await fetch(BASE + '/api/demo/limits')).json();
      $('#try').hidden = false;
      if (limits.available) startButton();
      else { demoButtons([]); demoNote(limits.reason || 'The demo is busy right now. Try again in a few minutes.'); }
    } catch {
      $('#try').hidden = true;
    }
  }

  // ---------- tabs --------------------------------------------------------
  function setMode(mode) {
    if (mode === 'live' && !LIVE) return;
    state.mode = mode; state.selected = null; stopAnim();
    for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.mode === mode));
    showList();
  }
  for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => setMode(b.dataset.mode));
  setMode(state.mode);
  setUpDemo();
})();
`;

function renderPage({ nonce, basePath, liveEnabled, homeHref = '/', cssHref = '/labs/assets/glasscliff.css' }) {
  const attr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Operations dashboard · Glasscliff</title>
<meta name="description" content="Watch joiners, role changes and leavers move from Okta into a downstream app, step by step.">
<link rel="stylesheet" href="${attr(cssHref)}">
<style nonce="${attr(nonce)}">${CSS}</style>
</head>
<body data-base="${attr(basePath)}" data-live="${liveEnabled ? 'true' : 'false'}">
<a class="skip" href="#main">Skip to content</a>
<div class="wrap wide">

<header class="masthead">
<a class="mark" href="/"><b>glasscliff</b>.online</a>
<nav class="nav" aria-label="Site">
<a href="/">labs</a>
<a href="https://glasscliff.online/blog.html">write-up</a>
<a href="https://glasscliff.online/">resume</a>
</nav>
</header>

<main id="main">
<section class="hero">
<p class="back"><a href="${attr(homeHref)}">Identity Lifecycle Lab</a></p>
<h1>Operations dashboard</h1>
<p>When someone joins, changes role or leaves, Okta has to carry that change into every app they use. Each run shows its steps as they landed, from Okta through to Glasscliff Expenses, and into Entra ID and Google for runs that went that far.</p>
</section>
<section class="try" id="try" hidden>
<h2>Run one yourself</h2>
<p id="try-lede">Start a throwaway person, move them to a new role, then offboard them. They get a simulated Expenses session at hire, so you can watch offboarding end it. The Okta account and the SCIM calls are real; nobody real is involved, and the account deletes itself.</p>
<div class="row" id="try-row"></div>
<p class="note" id="try-note"></p>
<div class="check" id="check" aria-live="polite" hidden></div>
</section>
<div class="tabs" role="tablist" aria-label="What to show">
<button role="tab" data-mode="live" aria-selected="false"${liveEnabled ? '' : ' disabled title="Live runs are unavailable right now"'}>live runs</button>
<button role="tab" data-mode="replay" aria-selected="false">replays</button>
</div>
<div class="layout">
<nav aria-label="Runs"><ul class="runs" id="runs"></ul></nav>
<section class="detail" id="detail"><p>Loading…</p></section>
</div>
</main>

<footer class="foot">
<span>People appear as pseudonyms such as person-3a9f1c. Email addresses and Okta ids are never sent to this page. The same person keeps the same pseudonym across runs.</span>
</footer>

</div>
<script nonce="${attr(nonce)}">${CLIENT}</script>
</body></html>`;
}

module.exports = { renderPage };
