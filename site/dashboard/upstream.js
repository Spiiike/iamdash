'use strict';
// Read-only client for the lifecycle API. The operator key is added here and
// never leaves the server. Only GET /operations and GET /status/{id} exist.
function createUpstream(cfg, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  const cache = new Map(); // key -> { at, ttl, value }
  const inflight = new Map(); // key -> promise (coalesces concurrent requests)
  const MAX_ENTRIES = 300;

  async function get(path) {
    const res = await fetchImpl(`${cfg.lifecycleEndpoint}${path}`, {
      headers: { [cfg.operatorHeader]: cfg.operatorKey, accept: 'application/json' },
      signal: AbortSignal.timeout(cfg.upstreamTimeoutMs),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw Object.assign(new Error(`lifecycle API returned HTTP ${res.status} for ${path}`), { upstreamStatus: res.status });
    return res.json();
  }

  async function cached(key, ttlFor, load) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < hit.ttl) return hit.value;
    if (inflight.has(key)) return inflight.get(key);
    const p = load()
      .then((value) => {
        if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
        cache.set(key, { at: now(), ttl: ttlFor(value), value });
        return value;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  // Demo actions: never cached, and they are the only non-GET calls made.
  async function post(path, body) {
    const res = await fetchImpl(`${cfg.lifecycleEndpoint}${path}`, {
      method: 'POST',
      headers: { [cfg.operatorHeader]: cfg.operatorKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(cfg.demoTimeoutMs || cfg.upstreamTimeoutMs),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json };
  }

  const TERMINAL = new Set(['succeeded', 'failed']);
  return {
    listOperations: () =>
      cached('list', () => cfg.listTtlMs, async () => (await get(`/operations?limit=${cfg.listLimit}`))?.operations || []),
    post,
    // Uncached GET, for small live values like the demo's current limits.
    getFresh: (path) => get(path),
    getStatus: (id) =>
      cached(`status:${id}`, (op) => (op && TERMINAL.has(op.status) ? cfg.doneTtlMs : cfg.liveTtlMs), () => get(`/status/${encodeURIComponent(id)}`)),
  };
}

module.exports = { createUpstream };
