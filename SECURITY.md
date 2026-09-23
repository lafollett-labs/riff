# Security

Riff runs autonomous agents that write files, run shell commands, and spend
money. That is the point of it, and it is also the whole security problem. This
document says what is actually contained, what is not, and how to check both
yourself rather than take our word for it.

## Reporting a vulnerability

Open a [security advisory](https://github.com/clafollett/riff/security/advisories/new)
rather than a public issue. If you would rather not use GitHub, email
`cali.lafollett@gmail.com` with `riff` in the subject.

There is no bounty. There is a fast answer and public credit unless you would
rather not have it.

## The threat model

The agents are the untrusted party. Not because anyone assumes bad intent, but
because a language model that has been running unattended for nine hours with a
shell and a git repository does not need bad intent to do damage. Everything
below is designed on the assumption that a staff member will, sooner or later,
try something nobody anticipated — and that no instruction in a prompt is a
control, because the thing reading the prompt is the thing being contained.

**In scope.** A staff member reaching outside its company; reaching the host
filesystem; reaching the network; escalating its own permissions; spending past
the cap; one company reading or writing another; an imported company reaching
outside the directory it was unpacked into.

**Out of scope.** A staff member writing something wrong, rude, or useless
inside its own world. That is a management problem, and the board is the
control.

## What contains what

### One company cannot read another

The gate confines every file tool to the company's own world, and always has.
It cannot confine a shell: the shell branch of `makeCanUseTool` passes no path,
because a command string is not a path. `node -e`, `make`, and a script the
agent wrote last turn are all opaque to inspection. On 2026-09-05 Lathe read
`lafollett-labs`' world six times, and every one was logged as an ordinary
`gate.allow`.

Claude Code's own Bash sandbox closes it. Every shift in a container runs its
shell under bubblewrap, scoped to that company's directory; the restriction is
inherited by every descendant of the shell and cannot be loosened from inside.
Measured from a real shift after the change:

```
ls /data/companies                       -> lathe
cat /data/companies/fathom/config.json   -> No such file or directory
node -e readdirSync('/data/companies')   -> [ 'lathe' ]
```

Other companies are not permission-denied, they are absent. The third line is
the case no command inspection could catch: there is no path in the text.

`failIfUnavailable: true` and `allowUnsandboxedCommands: false` — a shift that
cannot be isolated fails loudly rather than quietly doing the thing the sandbox
exists to prevent.

**What this costs, and it is not free.** bubblewrap is built on unprivileged
user namespaces, and Docker's default seccomp profile refuses those to every
container: `unshare` is allowlisted only alongside `CAP_SYS_ADMIN`, so it falls
through to `SCMP_ACT_ERRNO`. Measured four ways — a plain `docker run` with no
hardening, `--cap-drop ALL`, the full factory profile, and `seccomp=unconfined`
— and only the last permits it. `docker/seccomp-userns.json` is Docker's own
profile with one group added; the posture is unchanged otherwise and the
default action is still `SCMP_ACT_ERRNO`.

Unprivileged user namespaces are the richest container-escape CVE class of the
last decade, so this is a real widening of the outer wall to buy an inner one
that nothing else provides. **On macOS a LinuxKit VM sits under the container,
so an escape lands in a VM rather than on the host. On a Linux host it does
not.** An operator running Riff directly on Linux is accepting more than one
running it on a Mac.

### A write into the hidden region succeeds and is then discarded

A write to another company's directory reports **exit 0** and does not persist.
Nothing escapes — verified from inside the container and again on the host:

```
touch /data/companies/probe.txt   -> exit 0
stat  /data/companies/probe.txt   -> No such file or directory
~/.riff/companies/                -> fathom  lafollett-labs  lathe  prism
```

The cause is how the region is hidden. Denying *read* means the path cannot be
a bind of the real directory, so bubblewrap covers it with a scratch layer that
is writable and thrown away when the command exits. Denying *write* as well
does not change it — measured, with `denyWrite` on the same path, and the write
still returned 0.

So it is a reporting bug, not a leak, and it is confined to the hidden region.
Everywhere else the sandbox refuses loudly: `/tmp` answers `Read-only file
system` and a non-zero exit. `$TMPDIR` (`/tmp/claude-<uid>`) is writable and is
what tools should use.

**Why it is not fixed in the sandbox.** The two properties trade against each
other. Hiding the other companies gives silent discards; binding them read-only
instead makes writes fail loudly but puts every company's name back in view,
and the deny list would have to be rebuilt whenever a company is founded — a
gap that lasts until the next shift. Robust invisibility is worth more than
loud failure on a write that was already forbidden.

What is done instead: every contained session is told, in its system prompt,
that exit 0 there means nothing and that anything which must persist belongs
under its own directory. That is a correctness warning to the author of a
program, not a security control — the security control is the kernel, and it
holds.


### The shell is decided by where the runtime is, not by who is asking

`Bash` is refused outright on an operator's own machine, and no argument from
inside a session changes that, because the decision is not in the prompt — it
is in [`src/runtime/permissions.ts`](src/runtime/permissions.ts):

```ts
export const shellIsContained = (env = process.env): boolean =>
  env['RIFF_CONTAINED'] === '1'
  && (existsSync('/.dockerenv') || existsSync('/run/.containerenv'));
```

Both signals are required and it fails closed. The environment variable alone
would let a mistyped `export` open a shell on someone's laptop; the container
marker alone would open one in any container, including one built for something
else. Clone this repository and run it directly and the staff have no shell at
all.

### Every tool call crosses one chokepoint, and the default is deny

The Agent SDK routes every tool call — built-ins included — through
`canUseTool`. That function is wired to the company's rules, and an unrecognised
tool is **refused**, so adding a tool to the SDK later cannot silently widen
what the staff can do.

Paths are classified before any read or write: inside your own files, in the
commons, in a colleague's files, or outside the company. Outside is refused.

### The container has no route to the internet except through a proxy

`docker/compose.yaml` puts the factory on an `internal: true` network, which
blocks traffic in **both** directions. Outbound requests go through a tinyproxy
sidecar. Two more services exist only because of that: an `ingress` sidecar to
publish the console on loopback (an internal network cannot publish ports), and
the egress proxy itself, which runs as `user: tinyproxy` with its filter
compiled at build time so the image can stay read-only.

**The proxy was an allowlist until 2026-09-03. It is now a denylist, and this
changes what it is for.** A researcher spent a shift and four sub-agents on 195
`external.read` calls — every one allowed by the gate — and fetched exactly one
host. Asked for real prices from real pricing pages, the company could not read
one, and reported a ninefold spread on a figure it could not check. A curated
list cannot anticipate which vendor a company needs to price next.

So the proxy no longer claims to be a containment boundary. It refuses the
hosts whose whole purpose is to accept a payload from a stranger — paste sites,
webhook catchers, tunnelling services — which stops drift and accident, and is
not claimed to stop intent. Everything it passes, it now logs, one line per
request: `LogLevel Connect`, and `docker/up.sh logs egress` is the record.

Verified against a live stack, and worth re-running if you change anything:

| Check | Result |
| - | - |
| Ordinary host through the proxy | request arrived |
| Denylisted host through the proxy | refused |
| `pastebin.com.evil.example` (suffix attack on the denylist) | passed, and logged |
| Any host, ignoring the proxy | no route |
| Shell inside the container | works |
| Same shell reaching the host | shut |

### Your data is outside the box

`~/.riff` is a bind mount, so every company is ordinary files on your disk
whether the container is running or not. `docker/backup.sh` snapshots them to a
destination that is deliberately **not** mounted into any container — a copy the
agents can also reach is not a backup, it is a second thing to lose.

`docker/entrypoint.sh` refuses to start if `RIFF_ROOT` escapes the mount,
which is the failure that once wrote a whole company to a layer that vanished on
restart.

### A shift's transcript lives on the volume, inside its own company

Until 2026-09-13 the CLI's transcripts lived on the container's tmpfs `$HOME`
and died on every restart — the price of keeping `.credentials.json` off disk, a
file that no longer exists (a shift authenticates through the keyproxy's runtime
route on a scoped token, so there is no credential file, and no token in the
environment either). So transcripts now persist under
the company's own home on the durable volume: the CLI's store at
`companies/<slug>/.claude` (via `CLAUDE_CONFIG_DIR`), so a shift resumes instead
of starting cold, and the company's own audit — every turn, tool call and result
recorded from the SDK stream — at `companies/<slug>/transcript.db`. This is
`config.json`'s neighbour, never inside `world/`, or the end-of-turn commit would
stage the transcript into the company's own repo.

`sandboxFilesystem` (`src/runtime/staff.ts`) keeps two boundaries across this:

- **Between companies.** A shift's Bash is denied the whole installation root —
  `installRoot()`, i.e. all of `/data`, which holds `secrets/`, `master.key` and
  every other company — and re-admitted only its own home (`allowRead` is
  `dirname(worldRoot)`). One company cannot read another's transcript any more
  than it can read another's ledger or secrets.
- **Around the CLI's private store.** The `.claude` subtree (its resume JSONL and
  `.claude.json`) and `.credentials.json` are denied *even inside* the company's
  own home, so a shift cannot read the CLI's conversation store — or a credential
  file, were one ever present — through Bash.

What this does NOT do, and was never meant to: hide a company's own record from
its own staff. Its home is inside its own boundary, so its Bash can read its own
`transcript.db` and `ledger.db` as bytes — the wall is between companies and
around the credentials, not between a company and its own history. It cannot
*write* them; see the next section.
The stores hold agent-authored text (prompts, reasoning, tool input and output),
never a secret: the runtime token and the product keys alike live in the vault
the proxy reads one container away (below), never in the factory. Backups follow the same rule
as everything else on the volume — `docker/backup.sh` carries the transcripts to
a destination no container mounts.

### A shift cannot rewrite what governs it

Until 2026-09-22 a shift's Bash could write every file in its company's home,
including the three the gateway runs the company by: `ledger.db` (approvals,
spend, each seat's model and effort), `config.json` (policy) and
`transcript.db`. Nothing had used it. The gap was that `allowWrite` was the whole
home, which a coding company needs: ShipIt keeps a 3.2 GB Go toolchain and its
git worktrees beside its world.

So the home stays writable and those files do not (`companyControlFiles` in
`src/runtime/staff.ts`, the WAL and shared-memory files included). Measured from
a contained probe in a throwaway company, before and after:

| Check | Before | After |
| - | - | - |
| append to `config.json`, `ledger.db`, `ledger.db-wal`, `transcript.db` | ok | `Read-only file system` |
| rename `config.json` | ok | refused |
| overwrite `config.json`; write `ledger.db` through a symlink | ok | `Read-only file system` |
| hard-link `ledger.db` to a new name, to write that | — | `Invalid cross-device link` |
| delete `ledger.db-shm` | — | `Device or resource busy` |
| make a directory beside `world/` | ok | ok |
| write inside `world/` | ok | ok |
| read `/data/master.key` | denied | denied |
| reach the gateway on `127.0.0.1:4173` or `factory:4173` | unreachable | unreachable |

The last row is worth stating on its own: the console's API has no
authentication, and a shift's shell cannot reach it — loopback is refused and
the name does not resolve inside the sandbox. One cost: `sqlite3` in a shift can
no longer open its own ledger, because reading a WAL database writes its
shared-memory file. The staff read their company through their tools, not the
file.

### A file tool cannot follow a link out of its company

The gate vets a file tool's path, links resolved, in the factory, and then the CLI
opens that path itself. Until 2026-09-22 the CLI did that outside bubblewrap, with
the factory's full view. A shell running in parallel could swap a directory
below `world/` for a link between the check and the open. Read, Write and Edit
would then follow it into another company or the secrets store. No gate check
can close that, because the gate never holds the file open.

So when contained, the whole CLI now runs in a mount namespace of its own
(`cliConfinement` in `src/runtime/staff.ts`). The installation root is an
empty tmpfs with only this company's home bound back in. The control files are
bound read-only over it, and `$HOME` and `/tmp` are fresh for each shift, sized
as compose sizes the shared ones. The Bash sandbox nests inside it unchanged. A
home that is not strictly below `companies/` is refused rather than bound back,
since binding the root would undo the rest. Measured with a real Haiku shift in
a throwaway company:

| Check | Result |
| - | - |
| Bash: `ls /data/companies`; does `/data/master.key` exist | own company only; absent |
| Write, Edit, Read inside `world/` | ok |
| Write `config.json` | refused (`EBUSY`) |
| Read `master.key` by path | `File does not exist` |
| a link planted to `master.key`, read through it | `No such file or directory` |
| any process's `/proc/<pid>/root/data/master.key`, from inside | 0 of all |
| the gateway's `/proc/7/fd/*` (32 open), from inside | listed; 0 followed, 0 opened |
| the gateway's `environ`, `root`, `map_files`, from inside | denied |
| a neighbouring confined process's `environ` | denied from inside; readable from a factory shell |
| any process's `cmdline` | readable — world-readable by design |

The `/proc` refusals come from the user namespace bubblewrap creates: the same
reads succeed from a plain shell in the factory, under the same uid, and fail
from inside the view (`/proc/self/ns/user` differs). `cmdline` is not guarded
by it, so nothing secret belongs in a process's arguments.

A link can still point anywhere. Wherever it points, it resolves inside the
company — and inside the company it reaches whatever the CLI can write, which
includes the CLI's own store (`<home>/.claude`) that the Bash sandbox is denied.
The claim is between companies, not within one.

A fresh `$HOME` also ends the one writable directory every company's shell
shared: `~/.cache`, `~/.npm` and `~/.undo` exist for each shift and go with it.

### The gateway runs nothing a world's repository says to

Every shift's work is committed by the gateway, outside the sandbox, with git
running over a repository the staff write. Git runs commands a repository asks
it to — a hook, an `fsmonitor`, a filter or `textconv` driver, a signing
program — and any of them would have run as the gateway, past bubblewrap, where
`master.key` and every other company are readable. Three routes reached it:

- the **file tools** run outside bubblewrap, and the gate classified
  `world/.git/hooks/pre-commit` as commons, so Write could plant a hook
  (the CLI's own sandbox already protected `.git/hooks` and `.git/config` from
  Bash; the file tools went around it);
- **Bash** could replace `.git` itself — a gitdir file, `commondir`, or
  `objects/info/alternates` — and aim the gateway at another repository;
- an **imported** `.riff.tar.gz` carries whatever `.git/config` its author wrote.

Closed in layers, in `src/worldfs/git.ts` and `src/runtime/permissions.ts`:

- every git call the gateway makes passes `-c core.hooksPath=/dev/null
  -c core.fsmonitor=false` and turns signing off, which outranks anything in the
  repository's config;
- before running, the repository is vetted: `.git` must be a real directory,
  with no `commondir` or `alternates`, and every key in `.git/config` must be on
  a short allowlist (identity, branch tracking, core layout). Anything else —
  a filter, `include.path`, `core.worktree` — is refused, not neutralised one
  key at a time, because the list of settings that run commands grows with git;
- the gate treats `world/.git` as outside the company, in any letter case (the
  volume is a macOS bind mount, where `.GIT` is `.git`);
- the vet also refuses a symbolic link anywhere in the metadata git touches
  (the top of `.git`, all of `refs/` and `logs/`, the top of `objects/` and of
  `worktrees/`); the reflog, auto-gc and background maintenance are off for the
  gateway's calls;
- after each shift the gateway runs `git worktree prune` for the staff, who
  cannot (the sandbox mounts each `.git/worktrees/<name>` read-only piece by
  piece; ShipIt had 25 stuck). Prune deletes a stale entry recursively and git
  opens a linked one as the directory it points at, which from the gateway is
  anywhere — so the `worktrees/` link check comes first, and the test plants
  one and checks its target survives. Entries younger than two hours are left:
  a checkout in a shift's private `/tmp` reads as gone from outside;
- repositories nested inside the world — a staff member's own tool, or a
  worktree (ShipIt had eleven) — have their own config the vet never reads, and
  `git add -A` inspects them. The gateway's add, status and diff are scoped to
  leave every nested repository out (`nestedRepos`, matching `.git` in any case),
  so they stay the staff's to run git in and never the gateway's;
- `world/` cannot be moved aside from a shell: measured, a rename is refused
  (the CLI places its own protective mounts inside it, and `world/` is listed as
  a writable mount of its own). It is also pinned by inode when the company
  opens, and every gateway path — file reads, the gate's realpath check, a
  shift's cwd, each commit — refuses a `world/` that has become a link or a
  different directory. The home around it stays writable on purpose: making it
  read-only was measured to stop the CLI's sandbox starting at all.

`test/world-git-trust.test.ts` plants each route and asserts nothing ran.
Removing the hooks override, or the nested-repository scoping, makes its test
fail — which is how each was checked.

### The runtime token is not in the factory at all

Until the cutover the runtime token was an environment variable on the factory:
readable by any shell in the box, and visible on the host through `docker inspect`
to anyone who could reach the Docker socket. It is not there any more. The agents'
own Claude credential lives encrypted in an install-level vault — set in the
console under Riff Settings, or overridden per company — and the keyproxy injects
it on egress exactly as it does a company's product keys (below). A shift is
pointed at the proxy's reserved `_runtime` route carrying only a scoped, per-shift
token; the real credential never enters the factory's environment, a tmpfs,
`config.json`, git, or a `.riff.tar.gz`. `docker inspect` on the factory shows no
token, and no shell in the box has one to read.

Be clear about the limits, because they are real. The scoped token a shift *does*
carry is not secret — it sits in the CLI's environment, which a neighbouring
shift's confined processes are refused (measured, see "A file tool cannot follow
a link out of its company") but any process outside them under the same uid can
read — and it is short-lived, company-scoped, and useless off the proxy, and
the real credential it stands in for is a container away. And the egress proxy is
not a containment wall: **secrecy of a scoped token is not the control, and since
2026-09-03 neither is the proxy.** Its allowlist was retired — every allowlisted
host accepted a GET with a query string, so wikipedia and arxiv were exfiltration
channels of the same shape — and egress is open, so a determined process inside
the factory can send what it holds.

What remains, honestly: the real credentials are in the proxy, so what a shift can
read is a capped, revocable scoped token and never the account behind it; the gate
mediates every tool call and R3 sends anything outbound to the board as a draft;
and the proxy logs every request, so what was fetched is answerable after the
fact. Those are a scope control, a workflow control and an audit trail. None of
them is a wall. Run this on hardware you are willing to have a determined process
act from.

Migrating from the old env-token model: `up.sh` and `compose.yaml` no longer read
`RIFF_TOKEN_CMD`, `RIFF_CREDENTIALS_CMD` or `CLAUDE_CODE_OAUTH_TOKEN`, so any such
line left in your `docker/.env` or `$RIFF_ENV` is now inert. Delete them — a dead
plaintext token or credential-fetch command is exposure with no benefit — and set
the runtime credential once in the console under Riff Settings.

### A company's own keys live one container away, not in the factory

The runtime token above is Riff's own — an installation default, or a per-company
override. A company also has keys of its OWN — a model backend it pays for, its
product's API — and the same rule holds for both: "anything in the factory box is
readable by a shell that has run long enough", so a real key is never put in the
box. One mechanism carries them, in three parts, and only the third is new to
reason about:

- **The vault.** `src/core/secrets.ts` encrypts each company's secrets with a
  per-company data key, itself wrapped under a master key at `~/.riff/master.key`
  (`0600`). The master key and the vault files sit at the installation root,
  **outside every world**, so the shift sandbox — which re-allows a shift to read
  only its own world — never sees the ciphertext, let alone the key that unwraps
  it. The runtime default lives beside them in an install-level vault
  (`install.vault.json`) sealed under the same master key; a company's own runtime
  override and its product keys are in its per-company vault. `/api/secrets` and
  `/api/settings` write a value and can report that one is set; no endpoint reads a
  value back.

- **The proxy.** `src/keyproxy/main.ts` runs in its OWN container
  (`docker/compose.yaml`, service `keyproxy`), hardened to the egress bar and
  mounting the data volume read-only. It is the one process that decrypts a real
  key, and it does so to inject it on a call and forward it upstream: a company's
  product keys on the `/svc/<name>` routes it declared, and the agents' own runtime
  credential on the reserved `_runtime` route, synthesized from the stored type —
  never a service any company can declare (`SERVICE_NAME_RE` bars the leading
  underscore). The factory never runs this code and never holds a key.

- **The scoped token.** A shift calls `http://keyproxy:8890/svc/<name>` — its
  product routes, and the `_runtime` route for the agents' own inference — with a
  per-shift token that says only "the bearer is company X, until time T", signed
  with a secret at the installation root the sandbox cannot read
  (`src/core/proxytoken.ts`). `staff.ts` points the SDK at the runtime route with
  this token (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`) and strips any
  inherited raw token from the child env. The agent may read its own scoped token —
  that is the point, its product and its inference both use it — but cannot forge
  one for another company, and never sees the key the proxy swaps in.

**What this buys, precisely:** a company's real key is never on the factory's
disk, in its env, in `config.json`, in git, or in a `.riff.tar.gz` — an exported
company carries its `services` routing but not its vault, so a copy handed to
someone else authenticates to nothing. The proxy injects only for a request to a
service the company declared, at a host fixed by config, and logs one line per
call without the key in it.

**What it does not buy, and do not mistake it for more:** a scoped token read out
of a shift's process environment is a valid token. A neighbouring shift is
refused that read by its user namespace, not by the token — the exposure is a
shared `/proc` under one uid, a container-model property, and anything that runs
outside the confinement under that uid has it. Signing makes a token unforgeable, not unstealable,
and the residual is a company spending against another's key up to that key's
own cap, not reading it. The real key is unaffected: it is in the proxy, which
no shift's `/proc` reaches.

### The plan's usage is read from inside the stack

The five-hour and seven-day windows the throttle paces on used to arrive from
outside: a host process read the operator's own interactive Claude login from
the Keychain, called `/api/oauth/usage`, and posted the result to an
unauthenticated gateway endpoint. That process, its daemon and the endpoint are
gone. The windows now come off the runtime credential's own responses —
Anthropic answers every inference call with them in `anthropic-ratelimit-unified-*`
headers — which the keyproxy, already on that path, reads and keeps:

- only for calls billed to the **installation's** credential; a company on its own
  credential is another account and is not the plan the operator paces by;
- served on the keyproxy's `GET /usage` to a scoped token for the reserved
  `_install` audience, which only the gateway can mint (the signing secret is
  outside every world) and which `slugId()` can never produce — so a company's
  own token cannot read the installation's plan; the same audience reaches no
  company service;
- percentages and reset times only, never a credential.

While shifts run, the reading refreshes itself. While nothing does, the gateway
sends one Haiku call with a one-token answer once the reading is older than the
interval in Riff Settings (default ten minutes, 0 off) — measured at 9 input
tokens and 1 output — and at most once per interval whatever comes back.

### One writer per installation

The host and the container mount the same `~/.riff` on purpose. Two servers
on it is not a conflicting file — it is two schedulers waking the same staff,
doubling the spend, committing to one git repository from two sessions, and
writing both their accounts into one ledger. The gateway takes a lock at
`~/.riff/.lock` before anything opens a ledger, and refuses to start
against a live one.

Liveness is a heartbeat rather than a pid, because a container's pid 7 says
nothing about the host. A lock whose heartbeat stopped is stale and gets taken
over, so a killed server does not wedge the installation.

### The spend cap is a transaction, not a check

Recorded under `BEGIN IMMEDIATE` in SQLite, so two staff members waking at the
same instant cannot both pass a cap that only one of them fits under.

### An imported company is data, not a promise

`.riff.tar.gz` files arrive from other people. Before anything is unpacked,
every member path is checked — absolute paths, drive letters and any `..`
component are refused, because `../../pwned` is a legal tar member and by the
time you notice it in the output directory it has already been written somewhere
else. After unpacking, a world containing a **symbolic link** is refused
outright: the path classifier resolves lexically and never follows a link, so a
link inside a world is a way around it.

An imported company always lands **paused**. Someone else's company starting to
spend your subscription the moment the copy finishes is not a feature.

Not covered: a decompression bomb. A hostile archive can fill your disk. The
entry count is capped at 50,000 as a blunt guard, but if you import an archive
from someone you do not trust, that is the risk you are taking.

### The operator's own settings never reach the staff

The SDK loads `~/.claude` settings and `CLAUDE.md` by default, which would give
every staff member the same borrowed personality and leak private operator
instructions into every session. Riff passes `settingSources: []` and a
plain-string system prompt, so a persona is its own.

## What is NOT contained

Say these out loud before you run it unattended.

- **The model can be talked to.** Nothing here defends against a staff member
  being persuaded by content it reads. The defence is that persuasion does not
  grant capability — the gate is not in the prompt.
- **Money.** The cap is per local day and enforced honestly, but an agent
  running all night inside the cap still spends up to the cap. Set it low first.
- **Anything you mount in.** The containment boundary is `/data`. Mount your
  home directory in and you have removed it.
- **Egress, now.** The proxy passes everything not on the denylist. It refuses
  the obvious data drops and logs the rest; it is hygiene and a record, not a
  boundary.
- **Outbound content.** Anything reaching beyond the company lands as a draft
  for the board. That is a workflow control, not a technical one — approve a
  draft and it goes.

## Checking it yourself

```bash
npm test          # 126 unit tests, including the container env contract
npm run test:ui   # 39 browser tests against a throwaway installation
```

`test/container.test.ts` asserts the container's environment contract against
what `src/` actually reads, so the compose file and the code cannot drift apart
quietly. `test/permissions.test.ts` covers the chokepoint, and
`test/transfer.test.ts` builds hostile tarballs by hand — GNU tar and bsdtar
both refuse to *store* a `..` member, which is exactly why the importer cannot
assume its input came from tar.
