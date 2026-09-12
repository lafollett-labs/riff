# Code Review — atomic config/vault writes + plaintext-guard hardening

**Verdict:** ✅ APPROVED (round 1 + remediation)
**Reviewer:** Marvin (orchestrator) + adversarial security PE
**Reviewed SHA:** `d7e93c6`
**Scope:** `src/core/atomicwrite.ts` (new), `src/core/config.ts`, `src/core/secrets.ts`, `src/company/registry.ts`, `src/company/transfer.ts`, `src/gateway/server.ts`, `src/keyproxy/main.ts`, `desk/src/views/Secrets.vue` + tests.

## What it is

A repo-wide fix for a real torn-read race, plus the loose ends from the
services/keyproxy reviews. `config.json` and the secrets vault were written with
a plain `writeFileSync` (truncate-in-place), and the keyproxy reads both fresh on
every request while the API writes them — so a reader could catch a half-written
file: `readConfigFile` swallows the parse error → `resolveConfig` serves defaults
→ a company's `services` vanish for that request (spurious 404); a torn vault
fails to decrypt.

`atomicWriteFileSync` (temp in the same dir → chmod → rename) now backs every
writer of a concurrently-read file: `config.json` (`setRunningFlag`,
`scaffoldConfig`, migration, `registry.update`, `transfer`) and the vault +
`master.key` + proxy-token secret via `writeSecret600`. `rename(2)` is atomic
over an existing target, the temp is always same-dir (no EXDEV), and the module
imports only `node:fs` (the keyproxy's no-`node_modules` invariant holds).

## What the reviewer verified holds (CRITICAL/HIGH/MEDIUM: none)

- **Atomic writer correct** on Linux/macOS: rename never truncates, target never
  lost, temp never orphaned on a thrown error, no directory-enumeration path
  trips over a `.tmp-*` sibling — which is exactly what makes `readVault`'s
  uncaught `JSON.parse` and `readConfigFile`'s null-fallback safe.
- **KP-4 plaintext guard fails closed on every hostname form** tried:
  `127.0.0.1.evil.com`, `localhost.`, `127.0.0.2`, `user:pass@evil`, `file://`
  all refused; the numeric shorthands (`127.1`, `0x7f000001`) that it allows all
  normalize to genuine `127.0.0.1`, so the traffic never leaves the host. Runs
  before any connection; nothing is placed on a header before the refusal.
- **No secret-value corruption** beyond the intended paste-artifact strip.

## Findings (all LOW/INFO) and resolution

| ID | Sev | Finding | Resolution |
| - | - | - | - |
| KP4-IPV6 | 🟢 | `::1` in the loopback set was dead — `URL.hostname` returns `[::1]` bracketed — so an http IPv6-loopback dev upstream was refused (fails closed, dev-convenience gap). | **Fixed** — match `[::1]`; tightened to an allowlist (`https` anywhere, `http` only to loopback) which also cleans up the exotic-scheme INFO. |
| ATOMIC-PERMS | 🟢 | The vault/key temp was created at umask-default before the chmod, a brief wider-perms window (shielded by the 0700 dir, so not exploitable; the comment overclaimed). | **Fixed** — temp created at the target mode from the start; chmod kept to defeat a permissive umask. |
| TRIM-LOSSY | 🟢 | `value.trim()` could silently corrupt a legitimate credential with meaningful edge whitespace (the vault is general-purpose, not only API keys). | **Fixed** — strip only surrounding CR/LF (the `sk-…\n` paste artifact), never all whitespace. |
| ORPHAN-TEMP | 🟢 | A SIGKILL/container-recreate between write and rename leaves an inert orphan `.tmp-*`. | **Accepted** — nothing enumerates by glob (verified), so orphans are inert; a reaper is scope not worth its own failure modes. |
| SCHEME-INFO / TEST-SMELL | ℹ️ | Exotic scheme to loopback → 500 not 502; vestigial assertions in the atomicwrite test. | **Fixed** — scheme allowlist (above) makes it a clean 502; test assertions trimmed. |

## Tests + deploy

`npm run check` clean; 538 unit + 63 UI pass. New: `atomicWriteFileSync`
round-trip / exact-perms / temp-cleanup / failed-write-safety; the proxy's
non-https-non-loopback refusal. Deployed (both containers rebuilt) and
re-smoke-tested live against OpenRouter.
