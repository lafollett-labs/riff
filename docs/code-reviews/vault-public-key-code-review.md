# Code Review — the vault sealed to the keyproxy's key, each secret bound to where it goes

| Field | Value |
| - | - |
| Reviewer | Cali LaFollett (initiated by Marvin) |
| Review type | security review (crypto and keyproxy) plus infra review, three rounds each and a verify pass; live migration of this installation |
| Base SHA | e98080b |
| Files | `src/core/{secrets,config}.ts`, `src/keyproxy/main.ts`, `src/gateway/server.ts`, `src/company/registry.ts`, `src/mcp/server.ts`, `src/runtime/staff.ts`, `src/worldfs/git.ts`, `desk/src/{api.ts,views/Secrets.vue,views/Services.vue}`, `docker/{compose.yaml,up.sh,backup.sh,.env.example}`, `SECURITY.md`, `test/{secrets,keyproxy,services,registry,container,credential}.test.ts`, `e2e/desk.spec.ts` |
| Verdict | ✅ APPROVED |

## Origin

The gateway only writes secrets, yet it held `~/.riff/master.key`, which opens
every vault. It also loads the Agent SDK straight from npm on each release
(e98080b), so a bad SDK publish could have read every key.

Cali asked how to keep the key out of that process and still use its value.
The answer is public-key sealing: the gateway gets only the public key, and the
private key lives on a mount that only the keyproxy has.

## Design, as landed

- **Sealing.** Each value is sealed to the keyproxy's X25519 key:
  - a fresh ephemeral key per value, HKDF-SHA256, then AES-256-GCM with a 16-byte tag;
  - the vault file, the secret's name and `to` are bound in as additional data.
- **`to` (where the value may go).** The host, credential header and scheme,
  taken from the company's routes when the value is entered. The runtime token
  is bound to Anthropic.
- **What the keyproxy enforces.** It refuses a route whose destination is not
  in `to`, and a value whose `to` has been edited no longer opens.
- **Where the key lives.** The private key is in `~/.riff-keys` (the sibling
  of `RIFF_DATA`), and only the keyproxy mounts it. The factory fetches the
  public key, and any attempt there to load a private key throws.
- **Migration.** The gateway runs it at boot:
  1. checks a canary before rewriting anything;
  2. moves each vault, and names any that fail;
  3. renames the install vault to `_install.vault.json`;
  4. deletes `master.key` only when no vault still needs it.
- **Keyproxy hardening:**
  - credential headers come from an allowlist;
  - upstream error text is never echoed;
  - only GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS are forwarded;
  - no route may name the runtime token;
  - it refuses to start without its key while sealed vaults exist.
- **Desk.** Each key shows where it will be sent. Saving warns when a key goes
  nowhere, or when a route no longer matches its key.

## Measured live (this installation, 2026-09-23)

| Check | Result |
| - | - |
| boot | "3 secret(s) in 2 vault(s) resealed to the keyproxy's key; master.key deleted" |
| `~/.riff/master.key` | gone; backup taken first (`riff-2026-09-23T21-34-52.tar.gz`) |
| bindings | runtime token → api.anthropic.com in both shapes; `OPENROUTER_RIFF_SHIPIT_POC` → openrouter.ai `authorization Bearer`; `CLAUDE_SDK_RIFF_SHIPIT_POC` → api.anthropic.com `x-api-key` raw |
| factory: `/keys`, `/data/master.key`, opening a vault | absent; absent; "this process only seals secrets" |
| through the keyproxy: openrouter, anthropic, `_runtime` models lists | 200, 200, 200 |

## Findings

| Round | ID | Severity | Finding | Resolution |
| - | - | - | - | - |
| 1 | KP-1 | CRITICAL | A credential header of `host` put the key in the TLS SNI and then in the error the proxy returned | credential-header allowlist, in validation and in the proxy; error text never echoed |
| 1 | KP-2 / HIGH-001 | HIGH | The first-use pin was chosen by whoever called first, and was keyed on JSON the gateway writes | pins removed; destinations are sealed into each value when it is entered |
| 1 | KP-3 | HIGH | A route could name `RIFF_RUNTIME_TOKEN` | refused in both places |
| 1 | KP-4 | HIGH | Company slug `install` shared the install vault | `_install.vault.json` |
| 1 | KP-5 | MEDIUM | Decrypt and pin read the vault separately | one read returns the value and `to` |
| 1 | KP-6 | MEDIUM | A missing key was silently replaced; migration deleted `master.key` unverified | the keyproxy refuses to start; canary check |
| 1 | KP-7 | MEDIUM | A rename orphaned the vault | refused while the company has secrets |
| 1 | HIGH-002/003, MEDIUM-001, LOWs | HIGH–LOW | rootful Linux ownership; env-file `RIFF_KEYS`; sibling default; umask; tests | fixed |
| 2 | R2-1 | MEDIUM | The canary was checked after vaults were rewritten | checked first |
| 2 | R2-2 | MEDIUM | The Desk dropped `boundTo`/`warning` | shown; `stale` routes flagged; e2e test added |
| 2 | R2-3 | MEDIUM | TRACE was forwarded with the key | method allowlist; residual rows in SECURITY.md |
| 2 | R2-4..6, CRITICAL-001 | LOW / CRITICAL | locale sort; v1 read; tag length; an MCP string broke `npm run check` | fixed |
| 3 | R3-1, R3V-1 | MEDIUM / LOW | A partial or failed move could put back an old install token | the legacy file is removed once copied; install writes refused until the move |
| 3 | R3-2, HIGH-001 | LOW / HIGH | `up.sh` depended on `compose config`; `from_env_files` killed `backup.sh` under `set -e` | resolved from the env files; returns 0; `backup.sh` tests added |

## Residual, stated in SECURITY.md

A compromised gateway can still:
- read a secret typed into the Desk while it runs;
- delete or overwrite a secret;
- spend a key at its sealed destination.

Two things are not prevented, and a shift can do them as well as the gateway:
- an upstream that reflects the request back returns the key;
- a key can be moved to another tenant on the same host, since bindings cover
  the host and not the path.

A host run (outside Docker) holds the private key itself. Backups taken before
2026-09-23 hold `master.key`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
