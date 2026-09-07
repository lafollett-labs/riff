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

### A write outside the company succeeds and is then discarded

Inside the sandbox, a write to a path outside the company reports success and
does not persist: bubblewrap gives the command an ephemeral layer that is
thrown away when it exits. Contained, but silent — a program can believe it
wrote a file and be wrong. Found by Marlow on the first shift under the
sandbox, and recorded here rather than fixed, because the alternative is
lying to the kernel about what happened.


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

### The token is kept off your disk, and that is all that buys

`docker/.env` holds a command that prints the token rather than the token, and
`docker/up.sh` runs it at launch. So the credential is not sitting in plaintext
in a source tree where a backup, an editor's crash recovery, a home-directory
sync or a tarball of the repo will pick it up. It is never passed as an
argument, so it does not appear in `ps`; never typed, so not in shell history;
and never written, so not on disk.

Be clear about the limit, and it is a real one. Once the factory is running,
the token is in its environment and the staff have a shell — anything in that
box can read it, and it is visible on the host through `docker inspect` to
anyone who can reach the Docker socket. **Secrecy is not the control, and since
2026-09-03 neither is the proxy.**

This used to say that a readable token still could not be sent anywhere. That
was the allowlist's claim, it is retired, and it was always softer than it
read: every allowlisted host accepted a GET with a query string, so wikipedia
and arxiv were exfiltration channels of exactly the same shape. Egress is now
open, so a process inside the factory that wants to send the token somewhere
can.

What remains, honestly: the container holds a credential for the model and for
nothing else, so there is no second account to reach; the gate mediates every
tool call and R3 sends anything outbound to the board as a draft; and the proxy
logs every request, so what was fetched is answerable after the fact. Those are
a workflow control, a scope control and an audit trail. None of them is a wall.
Run this on hardware you are willing to have a determined process act from.

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
