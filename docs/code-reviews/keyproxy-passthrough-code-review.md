# Code Review — keyproxy transparent byte-pipe (fetch → node:http passthrough)

**Verdict:** ✅ APPROVED (round 1 + remediation)
**Reviewer:** Marvin (orchestrator) + adversarial security PE
**Reviewed SHA:** `3c39a77`
**Scope:** `src/keyproxy/main.ts`, `test/keyproxy.test.ts`.

## What it is

The keyproxy forwarded upstream responses with the global `fetch`; undici
auto-decompresses the body but keeps the upstream's `content-encoding` header, so
the proxy handed the client a decoded body still labelled `gzip` — every real
(gzipped) OpenRouter response failed with `Z_DATA_ERROR: incorrect header check`.
Found by a live smoke test before ShipIt ran on it.

The proxy never reads the body (it injects auth on the request and refuses
redirects on status/headers), so it should not decode. Rewritten as a transparent
byte pipe over `node:http`/`node:https` `request()` — node builtins, because the
keyproxy image ships **no node_modules** on purpose (its minimalism is a
security property, so undici's own `request()` is unavailable). Body and
`content-encoding` pass through untouched; `content-length`/`transfer-encoding`
are reframed by this hop.

## Security posture vs. the fetch version

The reviewer ran four adversarial repros and confirmed **no confidentiality
regression**:

- **Redirect refusal preserved (arguably stronger):** the core client never
  follows a redirect at the transport layer; a 3xx is refused (502) and its
  Location is never forwarded. Proven for both the bearer and custom-header
  (`X-Api-Key`) routes, including under a premature-close-during-drain attack —
  the attacker host is never contacted.
- **Single injection to the fixed host:** the scoped token (client
  `authorization`) is stripped and replaced; the real key is injected once toward
  the config-fixed host; the client cannot smuggle onto the injection header
  (lowercased keys, explicit drop, then set); the key is in no log or error.
- **Host fixed by config, TLS validated** (`node:https` `rejectUnauthorized`
  default), fail-closed gates (missing secret → 502, oversized body → 500) run
  before any forward.

## Findings and resolution

| ID | Sev | Finding | Resolution |
| - | - | - | - |
| KP-1 | 🟡 | **The one real regression — availability, not confidentiality.** `node:http` has no default timeout (undici's fetch applied ~300s); a stalling upstream hung the request forever, and on the *shared* proxy stalled requests accrue open sockets until it serves no company. Nothing tore down the upstream on client abort either. | **Fixed** — a 120s upstream timeout (env-tunable) that `destroy()`s and fails closed via the existing error handler; `res.on('close')` tears down the upstream when a caller (e.g. a killed shift) disconnects. `test/keyproxy.test.ts` proves a blackhole upstream returns 502, not a hang. |
| KP-2 | 🟢 | A throw inside the async response callback (e.g. `res.writeHead`) escaped both the awaited Promise and `handle().catch()` — an uncaught hang, not a 500; the outer catch was not the safety net it looked like for that branch. | **Fixed** — the callback body is wrapped; a throw drains the upstream and returns 502/ends, then resolves. |
| KP-3 | ℹ️ | Redirect branch drained without an `up.on('error')` (the success branch had one). Proven safe in Node 26, but asymmetric and version-fragile. | **Fixed** — a single `up.on('error')` covers both branches. |
| KP-4 | ℹ️ | The proxy trusts the config's protocol rather than re-asserting https itself. Not a regression (same boundary as fetch); `validateServiceRoute` enforces https at write time and a non-https route has no vault secret → 502. | **Accepted** — defense-in-depth follow-up (refuse a non-loopback http upstream at the proxy) noted, not required. |
| KP-5 | ℹ️ | A 3xx with an *empty* `Location` was forwarded rather than refused (`headers['location']` truthiness vs the old `headers.has`). No exfil either way. | **Fixed** — refuse on `'location' in headers`, matching the old guard. |

## Tests + live proof

`npm run check` clean; 532 unit tests pass; keyproxy suite includes gzip
passthrough proven on the raw socket (content-encoding forwarded, body still
gzip on the wire) and the blackhole-timeout regression. Verified live: a real
OpenRouter call through the rebuilt sidecar returns 200 with `content-encoding:
gzip` passed through and the client decoding it — the key never leaving the
proxy container.
