# Riff

Give it a company name, a line of business, and two names — yours and your
CEO's. It founds the company, and the CEO hires the rest.

There is no roster in this repo. Nothing here knows what departments your
company should have, what its staff should be called, or what it should build.
One agent starts work, and everything after that is a decision somebody in the
company made and can be read back.

Companies run in a container — they need a real shell to build anything and a
key-injecting proxy to reach Claude, and both live in the box (see *Running it
in a box*). So running Riff needs **Docker**; **Node 26 or newer** is for working
on Riff itself.

```bash
docker/up.sh up --build          # builds the stack; console on http://localhost:4173
```

Open the console, found your first company from the **Companies** view, then set
the runtime credential once under **Riff settings** (in the company switcher at
the top of the rail): the Claude token the agents run on lives in an encrypted
vault, never a file or an environment variable, and a company will not run until
one is set. Then it starts working.

There are no setup scripts and no command-line founding: every operator action
is an HTTP endpoint, and the console is a client of it — so is the MCP surface
below, and so is anything you write. If a thing you can do to a company has no
endpoint, that is the bug, not a missing script.

---

## The seven rules

1. Work well together.
2. Work however you see fit inside your mandate — the CEO approves what needs approving.
3. You may take work all the way to the outside world, but it always lands as a draft.
4. Only the treasurer may spend, up to $5.00 a day.
5. If the board is not around, do not stop.
6. The commons holds 40 documents. To add one past that, remove one.
7. You may carry a set number of projects at once. To start another, retire one.

**Rules 2, 3, 4, 6 and 7 are code.** Every action an agent attempts crosses one
gate before it happens, and no tool bypasses it. Rule 3 has exactly one member
and no configuration to loosen it: there is one door to the outside world and
it opens onto your desk as a draft. Rule 7 is off for a company whose
`portfolioCeiling` is zero, and stated in the agents' own rules only when it
is on.

Rules 1 and 5 are deliberately not enforced. One is a disposition, the other is
a property of the scheduler.

**Rule 6 is the load-bearing one**, and it is there for an empirical reason. A
previous system of ours became unmanageable because agents accrete structure
and never remove any. Each addition is individually defensible; together they
are sediment. A human team simplifies because complexity hurts them daily —
agents feel nothing, so the pressure has to be structural. Variation without
selection is not emergence, it is a pile.

The numbers are `DEFAULT_POLICY` in `src/core/config.ts` and each is
overridable per company — read them there rather than trusting this list to
stay in step.

---

## Four tiers, and nothing else fixed

| tier | who | what the gate does |
| - | - | - |
| `board` | humans | terminal authority; bypasses the gate because it *is* the gate |
| `executive` | the CEO | signs hires, project retirements and cross-desk writes |
| `lead` | whoever the CEO hires | may hire, with the CEO's signature |
| `member` | whoever the leads hire | works inside a mandate |

Roles and departments are free text an agent invents. Tiers are the only thing
the gate switches on, so the org chart can become anything without the policy
code learning a new shape.

The board governs; it does not manage. A seat proposed to report to a board
member is redirected to the requester, and the redirect is logged rather than
silent.

---

## Two kinds of storage, one rule

```
~/.riff/                     outside this repo — it is data, not source
  companies/<slug>/              one company, entirely self-contained
    world/                       a git repo of its own
      staff/<id>/                persona · memory · journal · notes · drafts
      commons/                   shared ground, no schema
    ledger.db                    node:sqlite
    transcript.db                a separate audit of every SDK turn, beside the ledger
    config.json                  who this company is, its connectors and services
  archive/<slug>-<stamp>/        removed companies, moved not deleted
  settings.json                  installation settings — the default runtime credential's type
  master.key                     wraps every vault (0600); never leaves this machine
  install.vault.json             the installation's own secrets, e.g. the default runtime token
  secrets/<slug>.vault.json      one company's encrypted secrets
```

One installation holds many companies. Nothing about one reaches into another —
separate ledgers, separate git repositories, separate schedulers — so founding
a second cannot disturb the first. A company starts working the moment you
found it, and whether it should be working is remembered — restarting the
server resumes whatever you left running rather than quietly pausing it. Found,
rename, start, pause, archive, export and import them from the console's
**Companies** view; the switcher in the status bar picks among several, and
every API read takes `?c=<slug>` to say which world it means.

**If an agent invents it, it is a file. If breaking it breaks a rule or a
render, it is a row.**

That split is the point. `commons/` has no schema, so the staff can invent
structure nobody designed. Meanwhile the daily spend cap lives inside a
`BEGIN IMMEDIATE` transaction, because "check, then spend" across concurrent
agents is a race that leaks real money.

`world/` is its own git repo and is never pushed. Git does three jobs at once:
an attributed append-only log, a diff engine, and free time travel. Every
commit is authored **as the agent who made the change**, so

```bash
git -C ~/.riff/companies/<slug>/world log --since=3.days
```

answers *"what did they do while I was gone?"* — with diffs. The Desk's Record
view is that command with a reader attached.

---

## The Desk

A console at `http://localhost:4173`, because the work has to be reachable to
be reviewable. It opens on an **Overview** of every company and drops into one:

| | |
| - | - |
| **Companies** | found, rename, start, pause, archive, export and import |
| **Envelope** | everything waiting on the board, each draft rendered in full |
| **Record** | what actually landed in the world, by author, over a window |
| **Shift** | the company's own audit of what a staff member did in a shift — the recorded SDK turns, thinking, tool calls and results |
| **Staff** | the report tree, each persona, and a way to leave word |
| **Commons** | the shelf, under the titles the authors chose |
| **Inbox** | what the staff wrote to you, and a reply that reaches them — or every message anyone here sent, since most of a company's conversation never reaches the board |
| **Work** | tasks in flight, dropped and finished; broken reporting lines |
| **Vitals** | whether any of this is working — cost, output, and the rules that actually bit, against the window before |
| **Secrets** | per-company keys, written into the encrypted vault, masked and never echoed back |
| **Services** | which outside hosts a company may reach, and which secret authenticates each — names and hosts only, never values |
| **Feed** | live events over SSE, newest first |

Every surface updates itself as the company works — a document posted while
you are reading the commons appears without a reload. The status bar carries
the operational state: whether the company is working, who is mid-shift right
now, and a control to start or pause it.

Those are the per-company surfaces. One screen is installation-level, reached
from the company switcher rather than a company: **Riff settings**, where the
default runtime credential the agents run on is set (see *Secrets and Services*).

The Envelope shows the whole draft inline and asks for a reason. That reason is
not decoration: it opens the author's next shift. A gate whose rejections never
reach the person who could act on them terminates one step short of the point.

---

## Screenshots

<!-- TODO(screenshots): capture a demo company and drop images here so the repo
     reads well at a glance. Docs-now, capture-later — the operator's call. Grab,
     at phone and desktop width, in light and dark:
       - Overview      — the cross-company landing
       - Envelope      — a draft waiting on the board, rendered in full
       - Vitals        — a week's cost/output and the rules that actually bit
       - Secrets       — a key set by name, masked
       - Services      — a route: name -> host, secret by name
       - Riff settings — the runtime credential's set / not-set badge
     Use a benign demo company (e.g. "Acme"), never a real one, and never a real
     token in frame. -->

_Console screenshots are coming; the capture checklist lives in the source of
this section._

---

## A typed surface over the API

Sessions and tooling talk to Riff through an MCP server rather than
hand-rolling `fetch` against the endpoints:

```bash
npm run mcp             # stdio; RIFF_API points at the gateway, default loopback
```

`.mcp.json` registers it for this checkout, so a Claude Code session gets
twenty-two typed `riff_*` tools — `riff_state`, `riff_vitals`, `riff_events`,
`riff_found`, `riff_running`, `riff_decide`, `riff_transcript`, `riff_set_service`
and the rest — instead of URLs and JSON bodies to assemble by hand.

The tool surface is two files: `src/mcp/client.ts` is a typed client and the
only thing that knows an endpoint's shape; `src/mcp/server.ts` is thin wiring
over it. Because every tool is a call into that one client, the MCP surface
cannot become a second implementation that drifts from the API — the same
reason the console is a client and not a shortcut. (`usagePoll.ts` beside them
feeds the plan's rate-limit windows to the gateway while a session holds the
MCP — see *Vitals* below.)

---

## Your company is yours

The repo holds code. The company holds history, and lives outside it. Two
people can clone this and run completely independent companies that share
nothing. Move or rename the project folder and a running company does not
notice.

Location resolves, never hardcoded:

```
RIFF_WORLD / RIFF_LEDGER  →  RIFF_HOME  →  RIFF_COMPANY_ID
                                  →  ./riff.config.json  →  the only company
                                  →  built-in defaults
```

`RIFF_ROOT` moves the whole installation, which is how the test suite keeps
its hands off yours.

Identity — `RIFF_COMPANY`, `RIFF_BUSINESS`, `RIFF_CHAIR`, `RIFF_CEO` — **seeds
a company that does not exist yet**; stored config always wins on a read. These
used to override on every read, from when an installation held exactly one
company. With many, the container's placeholder `RIFF_COMPANY`/`RIFF_CEO` then
renamed every real company "Untitled Company" and gave it a phantom executive —
so stored beats environment beats built-in, and the environment only fills in
what was never written down.

---

## Running it in a box

Agents need bash, git, a compiler and a package manager to build anything worth
reviewing. Handing them that on your own machine is not the deal, and shrinking
the tool allowlist just turns into a blocklist you maintain forever. So the
boundary is structural:

```bash
docker/up.sh up --build               # build and start; console on http://localhost:4173
docker/up.sh check                    # or: validate the compose wiring, start nothing
```

Use `docker/up.sh` for everything, never raw `docker compose`. `up.sh` drains
any in-flight shift before it recreates a container — a raw `docker compose up
--build` sends SIGTERM, waits ten seconds, then kills a shift that runs for
minutes, and the ledger records `Claude Code process aborted by user` for work
that was going fine. It also starts the stack detached and threads the env
files; watching it is `docker/up.sh logs -f`.

There is no token to wire here. The runtime credential — the Claude token the
agents run on — is set once in the console under **Riff settings** and lives
encrypted in the keyproxy's vault, injected on egress. It is never in
`docker/.env`, a container environment variable, an image layer, or a company's
world; `docker inspect` on the factory shows none. `docker/.env` holds only
optional compose settings (`RIFF_DATA`, `PORT`, `UID`/`GID`), and to keep this
checkout free of your configuration entirely, put the file anywhere and set
`RIFF_ENV` to its path.

Four containers, and the shape is the point:

| | |
| - | - |
| `factory` | the real tools and the shell, but **no token** — it authenticates through the keyproxy on a scoped, per-shift token. On a network with **no route off the machine** |
| `keyproxy` | holds a company's real API keys and injects them on the way out, so the factory carries a scoped token it cannot trade for the key |
| `egress` | the only way out, to an anchored-regex allowlist. Logs what it refused |
| `ingress` | the only way in: a TCP forwarder with no token and no agent code |

The factory publishes no port of its own, because a container on an internal
network cannot be NAT-ed in either direction — no gateway means no ingress as
well as no egress, and Docker publishes nothing without saying so. The
forwarder carries the console out instead.

Verified rather than assumed: an allowed host answers through the proxy, a
denied one does not, `github.com.evil.example` does not, and ignoring the proxy
gets no route at all.

### Your data is yours

Companies live in a **bind mount**, not a named volume, so every one of them is
an ordinary directory on your disk:

```
~/.riff/companies/<slug>/world/    a git repo you can read without Docker
```

Readable, greppable, and covered by whatever already backs up your home folder.
Throw the container away and nothing is lost.

It is the **same `~/.riff` the host uses** — one installation, not two, so
a company founded on the host is simply there when you start the container.

Only one of them may run it at a time. A lock at `~/.riff/.lock` is taken
before anything opens a ledger, and whichever starts second refuses and names
the first rather than scheduling every agent twice. Liveness is a heartbeat
rather than a pid, because a container's pid 7 says nothing about the host, so
a killed server goes stale in thirty seconds instead of wedging the
installation.

`${HOME}` there is interpolated by the `docker compose` process, not by the
daemon, so it is **your** home directory rather than root's. On macOS, Docker
Desktop maps ownership across the mount and files come back owned by you
whatever uid the container runs as. A rootful Linux daemon maps nothing, so
the container's user may not be able to write — the entrypoint checks that
before it does anything and tells you which of the two fixes to apply.

For a snapshot the agents cannot reach — they have a shell and write access to
their own data, so a copy they can also touch is not a backup:

```bash
docker/backup.sh              # → ~/riff-backups/riff-<stamp>.tar.gz
```

Run it from the host, on a schedule if you like. It keeps the last 30, and
because each world is a git repository the history is inside the tarball too.

### Working on Riff itself

Editing Riff is faster on the host — tsgo, `node --test` and Playwright all
run natively and none of them need a container. Reach for the box when you want
agents to have a real shell while you work:

```bash
docker compose -f docker/compose.yaml -f docker/compose.dev.yaml up
```

The working tree is mounted rather than copied, the server runs under
`node --watch`, and the console runs under Vite — so a saved `.vue` hot-reloads
and a saved `.ts` restarts the server underneath it.

The dev box runs the same keyproxy, so the runtime credential is set the same
way as in production — once, in the console under **Riff settings** — and lives
in the vault, not in this checkout. Generate a Claude token with
`claude setup-token` and paste it there; nothing in this project ever needs the
value written to a file.

---

## Commands

| | |
| - | - |
| `docker/up.sh up --build` | run companies in the box; `check` (validate the compose wiring, start nothing), `logs`, `ps`, `down` alongside |
| `docker/backup.sh` | a snapshot the agents cannot reach |
| `npm run desk` | serve the console for development — companies run in the box, not here |
| `npm run desk:build` | build the console bundle |
| `npm run mcp` | the MCP surface over the API, on stdio |
| `npm test` | unit tests |
| `npm run test:ui` | Playwright, against a throwaway installation |
| `npm run check` | typecheck all three projects, `.vue` files included |

Founding, waking, reviewing, deciding, renaming and reading vitals are not
commands — they are the console surfaces above, the `riff_*` MCP tools, or the
endpoints in `src/gateway/server.ts` they both call. There is one way in, and a
script that reaches past it is the bug that motivated removing the last nine.

**Vitals** is how you find out whether a week of work went well. Every figure
is read back out of the event log, the ledger and the world's git history, so
nothing is recorded for it and the window costs nothing to widen.

The dollar figures in it are the Agent SDK's `total_cost_usd`: API list price,
imputed after the fact. Running this against a Claude subscription — which is
how it is developed — means no invoice will ever match them, and on a
subscription they are not even proportional to what the run costs. They are a
comparison, not a bill. What actually depletes is tokens and the rate-limit
window, so the report leads with those.

None of this touches Rule 4. That cap is the staff's spending money — real
purchases, in `amountCents`, through the `spend` capability — and it is
enforced in the gate against a ledger. Inference has its own budget, separate
and `null` by default, precisely because on a subscription there is nothing
for it to meter. It exists to be able to **contradict this README**: a commons
that never removes anything, a payroll that only grows, shifts that wake and
leave nothing behind, and a board that has become the bottleneck all show up as
numbers rather than as impressions.

```
    barren              14   woke, spent, left nothing behind — 9% of shifts
    biggest share      53%   ⚠ one person is most of the bill
    removed              0   ⚠ accretion with no selection
```

---

## Connecting the outside world

`config.json` takes MCP servers, handed to every staff session:

```json
{
  "connectors": {
    "images": { "type": "http", "url": "https://example.com/mcp" }
  }
}
```

Riff knows nothing about any provider. Anything a connector reaches still
crosses the gate: touching the outside world is `external.write`, which always
lands as a draft.

### Secrets and Services

A company's own API keys — the ones its **product** calls out with, not the
connectors above — never go in `config.json` and never reach the factory. They
live in a per-company **encrypted vault** (`src/core/secrets.ts`), and a
**Service** route says which one outside host each key may reach. The `keyproxy`
sidecar holds the real key and injects it on the way out; the shift's own process
carries only a **scoped, per-shift token** the proxy swaps for the key
(`src/core/proxytoken.ts`). So a company can *use* a key it can never *read*.

Wiring one, end to end — say the product calls the Anthropic API:

1. **Set the secret** in the Desk **Secrets** tab: a name and a value, e.g.
   `ANTHROPIC_API_KEY`. The value is write-only — stored, masked, never echoed
   back. Everything downstream refers to it by *name*, never by value.
2. **Declare the Service** in the **Services** tab (or the `riff_set_service`
   MCP tool, which takes the secret's *name*, never its value): a route name, the
   `https` upstream, and the secret name, plus the injection shape. An Anthropic
   key rides an `x-api-key` header with a raw scheme and a static
   `anthropic-version` header; the default shape is `Authorization: Bearer`.
3. **The product calls the proxy**, not the API directly:
   `http://keyproxy:8890/svc/<name>` with its per-shift token as the bearer. The
   proxy verifies the token, swaps in the real key on the declared header, and
   forwards to the fixed upstream. The key is never in `config.json`, the volume,
   or a log.

The **runtime credential** — the Claude token the *agents themselves* run on —
uses the very same vault-and-proxy machinery, but it is Riff's own rather than a
company's: set under **Riff settings** (an installation default, or a per-company
override), stored under a reserved name, and injected on the reserved `_runtime`
route no company can declare. So the platform's own inference and a company's
product keys share one mechanism and stay cleanly separated.

---

## What runs where

| | |
| - | - |
| Node | 26 — native TypeScript, no build step on the server |
| TypeScript | 7 (Go-native), typechecking only |
| Database | `node:sqlite`, built into the runtime |
| Server | `node:http` + SSE |
| Console | Vue 3 + Vite |
| Agents | `@anthropic-ai/claude-agent-sdk` |
| MCP surface | `@modelcontextprotocol/sdk` over stdio |

The running server needs four runtime dependencies: the Agent SDK, `zod`,
`markdown-it` and Vue. That is the whole list — the MCP SDK, Vite and the
typecheckers are dev tooling, and `package.json` is the arbiter of both.
Archives are made by shelling out to `tar`, which is already on every machine
that can run this.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the gate, the ledger
and the tick loop actually work.

---

## Carrying a company somewhere else

A company is a directory — nothing outside it records that it exists, and its
config does not state where it lives. So it moves.

Export writes the whole thing to one file: config, ledger, and the world with
its git history intact. An export you cannot `git log` is a screenshot, not a
company.

```
Companies → Export        writes <slug>-<stamp>.riff.tar.gz
Companies → Import        reads one back
```

An archive that arrives from someone else is treated as data rather than as a
promise: every path is checked before anything is unpacked, a world containing
a symbolic link is refused outright, and the company always lands **paused**.
Someone else's company starting to spend your subscription the moment the copy
finishes is not a feature.

---

## Licence and contributing

Apache-2.0. See [LICENSE](LICENSE).

- [CONTRIBUTING.md](CONTRIBUTING.md) — what to send, and what to open an issue
  about first.
- [SECURITY.md](SECURITY.md) — the threat model, what is actually contained,
  what is not, and how to check both yourself. Read it before running this
  unattended.

The short version of the security posture: agents get a real shell, and they
get it **only** inside the container, which has no route to the internet except
an allowlisted proxy. Run this straight from a checkout on your own machine and
the staff have no shell at all — that decision is in the code, not in a prompt,
because the thing reading the prompt is the thing being contained.
