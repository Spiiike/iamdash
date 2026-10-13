'use strict';

/*
 * Read-only client for the reconciler's snapshot endpoint.
 *
 * Same shape and the same reasoning as dashboard/upstream.js: the operator key
 * is added here and never leaves the server, one in-flight request is shared by
 * concurrent callers, and a successful read is cached so a link doing the rounds
 * doesn't become one upstream call per visitor.
 *
 * The endpoint it reads is the *unmasked* snapshot, which is why it is private.
 * Masking happens on this side, in mask-snapshot.js, using dashboard/mask.js —
 * so there is exactly one masking implementation on the site and one key.
 */

function createUpstream(cfg, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  let cached = null; // { at, value }
  let inflight = null;

  async function load() {
    const res = await fetchImpl(cfg.snapshotEndpoint, {
      headers: { [cfg.operatorHeader]: cfg.operatorKey, accept: 'application/json' },
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (res.status === 404) return null; // never run yet
    if (!res.ok) {
      throw Object.assign(new Error(`reconciler returned HTTP ${res.status}`), {
        upstreamStatus: res.status,
      });
    }
    const body = await res.json();
    if (!body || !body.summary || !Array.isArray(body.users)) {
      throw new Error('reconciler returned a body that is not a snapshot');
    }
    return body;
  }

  return {
    /**
     * Returns { snapshot, stale }. On an upstream failure the last good
     * snapshot is served with stale:true rather than an error page — the whole
     * point of this lab is that a visibly old answer beats a confident wrong
     * one. Only a cold cache surfaces the failure.
     */
    async get() {
      if (cached && now() - cached.at < cfg.ttlMs) {
        return { snapshot: cached.value, stale: false };
      }
      if (inflight) return inflight;

      inflight = load()
        .then((value) => {
          if (value) cached = { at: now(), value };
          return { snapshot: value, stale: false };
        })
        .catch((err) => {
          if (cached) return { snapshot: cached.value, stale: true, error: err };
          throw err;
        })
        .finally(() => {
          inflight = null;
        });

      return inflight;
    },

    /** Test seam. */
    _peek() {
      return cached;
    },
  };
}

module.exports = { createUpstream };
