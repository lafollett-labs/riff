import { execFileSync } from 'node:child_process';
import { realpathSync, existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { lexists, readWithin, writeWithin } from './within.ts';
import { join } from 'node:path';
import { systemClock, type Clock } from '../core/clock.ts';

/**
 * The world's own git repo.
 *
 * The point of this file: commits are authored AS the staff member who made
 * the change. `git log` in world/ is therefore a complete, attributed,
 * diffable record of what everyone did while you were away — which is a
 * better answer to "what happened?" than any query I could write.
 *
 * execFile with an argv array throughout; nothing reaches a shell, so a staff
 * member naming a file `; rm -rf ~` is inert.
 */
/**
 * Everything in a repository that can make git run a command, switched off.
 *
 * The world is written by the staff, and this process runs git over it outside
 * the shift sandbox — every commit a shift makes is committed by the gateway.
 * A hook, an fsmonitor, or a signing program named in the repository's own
 * files would run as the gateway: past bubblewrap, able to read master.key and
 * every company. Flags given with -c outrank anything in .git/config, so these
 * hold whatever the repository says.
 */
const INERT = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'commit.gpgSign=false',
  '-c', 'tag.gpgSign=false',
  // A repository nested in the world is its own repository, with its own
  // config the vet below never reads. Status and diff otherwise descend into it
  // to see whether it changed, running whatever that config names.
  '-c', 'diff.ignoreSubmodules=all',
  '-c', 'submodule.recurse=false',
  '-c', 'status.submoduleSummary=false',
  // The reflog is a file git appends to; nothing here reads it.
  '-c', 'core.logAllRefUpdates=false',
  // No background work spawned after the call returns and the vet is behind us.
  '-c', 'gc.auto=0',
  '-c', 'maintenance.auto=false',
];

/**
 * The longest any git call may hold the gateway, whose loop every company
 * shares. The vet refuses the special files it can see; this bounds whatever
 * it cannot, such as a FIFO planted among the loose objects it does not walk.
 * On ShipIt's world (4,096 files) status takes 63ms and a whole-world add 22ms.
 */
export const GIT_TIMEOUT_MS = 10_000;
/**
 * `add` hashes whatever the staff dropped, and a legitimate drop is slow: 400MB
 * in 5,003 new files took 14.4s on the factory's volume, where every other call
 * here takes milliseconds.
 */
export const GIT_ADD_TIMEOUT_MS = 120_000;

const timedOut = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ETIMEDOUT';

/**
 * The repository-local settings git may find here. Anything else — a filter or
 * textconv driver, include.path, core.worktree, an extension that reads a second
 * config file — is refused rather than neutralised one key at a time: the list
 * of settings that run commands grows with git, and an allowlist does not have
 * to keep up with it. Riff's own init writes only the first two groups; ShipIt's
 * repository carried nothing else after two weeks of staff running git in it.
 */
const SAFE_KEY = new RegExp('^(?:' + [
  'core\\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)',
  'user\\.(?:name|email)',
  'init\\.defaultbranch',
  'gc\\.auto',
  'extensions\\.objectformat',
  'branch\\..+\\.(?:remote|merge)',
  'remote\\..+\\.(?:url|fetch)',
].join('|') + ')$', 'i');

/**
 * Why this repository cannot be trusted with git, or null.
 *
 * Separate from the flags above because some routes are not settings: a `.git`
 * that is a file or a link can point the gateway at another company's
 * repository, and `commondir` or `objects/info/alternates` borrow another
 * repository's refs or objects. Reads only — nothing here runs git.
 */
export const untrustedRepo = (dir: string): string | null => {
  const gitDir = join(dir, '.git');
  if (!existsSync(gitDir)) return null;           // not a repository yet; init makes a real one
  const st = lstatSync(gitDir);
  if (!st.isDirectory()) return '.git is not a directory';
  for (const f of ['commondir', 'objects/info/alternates']) {
    if (existsSync(join(gitDir, f))) return `.git/${f} borrows from another repository`;
  }
  // Git follows a link inside .git as readily as a real file, and this process
  // runs outside the sandbox that hides everything past the company — a linked
  // ref, log or object directory would read and write wherever it points.
  const odd = oddIn(gitDir);
  if (odd) return `.git/${odd.path} is ${odd.what}`;
  const cfg = join(gitDir, 'config');
  if (!existsSync(cfg)) return null;
  // `--file` never follows include.path, so an include is listed as a key and refused.
  const keys = execFileSync('git', ['config', '--file', cfg, '--list', '--name-only'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS }).split('\n').filter(Boolean);
  const bad = keys.find((k) => !SAFE_KEY.test(k));
  return bad ? `.git/config sets ${bad}` : null;
};

/**
 * The first link, FIFO, socket or device among the git metadata this process
 * touches, or null. Git reading a FIFO at .git/config or HEAD waits for a writer
 * that never comes, synchronously, holding every company's gateway.
 *
 * Walked: the top level of .git, all of refs/ and logs/ (small), the top of objects/ —
 * a linked fan-out or pack directory is alternates by another name — and the
 * top of worktrees/, because pruning deletes a stale entry there recursively
 * and git opens a linked one as the directory it points at.
 */
const oddIn = (gitDir: string): { path: string; what: string } | null => {
  const walk = (rel: string, deep: boolean): { path: string; what: string } | null => {
    let names: string[];
    try { names = readdirSync(join(gitDir, rel)); } catch { return null; }
    for (const n of names) {
      const r = rel ? `${rel}/${n}` : n;
      const st = lstatSync(join(gitDir, r));
      if (st.isSymbolicLink()) return { path: r, what: 'a symbolic link' };
      if (!st.isFile() && !st.isDirectory()) return { path: r, what: 'neither a file nor a folder' };
      const lower = n.toLowerCase();
      const meta = !rel && (lower === 'refs' || lower === 'logs');
      if (st.isDirectory() && (deep || meta)) {
        const hit = walk(r, deep || meta);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk('', false) ?? walk('objects', false) ?? walk('worktrees', false);
};

/**
 * Every repository nested below the world root, as world-relative paths, and
 * the first thing that is neither a file, a folder nor a link.
 *
 * A nested repository has its own config, which the vet never reads, and
 * `git add -A` inspects it to decide what to record. So the gateway's commands
 * are scoped to leave each one out: the staff's own repositories and worktrees
 * are theirs to run git in, and never the gateway's. Links are not followed.
 *
 * A FIFO anywhere git reads — a folder's `.gitignore`, a file it hashes —
 * blocks it until killed, and the vet walks only `.git`. This walk already
 * visits the whole tree before every add, status and diff, so it is where one
 * is caught, before git is run at all.
 */
export const worldTree = (root: string): { nested: string[]; special: string | null } => {
  const nested: string[] = [];
  let special: string | null = null;
  const walk = (rel: string): void => {
    let entries;
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return; }
    // Case-insensitively: the volume is a macOS bind mount, where git takes a
    // differently-cased .GIT for a repository just the same.
    const isGit = (n: string): boolean => n.toLowerCase() === '.git';
    if (rel && entries.some((e) => isGit(e.name))) { nested.push(rel); return; }
    for (const e of entries) {
      const at = rel ? `${rel}/${e.name}` : e.name;
      if (!e.isFile() && !e.isDirectory() && !e.isSymbolicLink()) special ??= at;
      if (!e.isDirectory() || (!rel && isGit(e.name))) continue;
      walk(at);
    }
  };
  walk('');
  return { nested, special };
};

export const nestedRepos = (root: string): string[] => worldTree(root).nested;

export class WorldGit {
  #dir: string;
  #clock: Clock;
  /** The world's own identity check (see World#assertRoot), run before every call. */
  #checkRoot: () => void;

  /**
   * The company's clock, not the machine's.
   *
   * Everything else in Riff takes one so time is controllable; git did not,
   * and stamped every commit from the system clock. Under a frozen clock that
   * put the world's history minutes ahead of the ledger's — a report window
   * closing before the commits inside it, failing about one run in four, and
   * a test wanting to age a project could not place a commit in the past at
   * all. Identical in production, where this IS the system clock.
   */
  /**
   * Why git stopped being run here, once a call timed out.
   *
   * A timeout alone turned a planted FIFO from a permanent hang into one of
   * GIT_TIMEOUT_MS on every later call — each commit, each vitals poll — with
   * the FIFO still there. After the first, nothing more is run until the
   * operator clears it (clearStall, through the API) or reopens the company.
   */
  #stalled: string | null = null;
  /** Let git run here again, after the operator has dealt with the stall; what it was, or null. */
  clearStall(): string | null {
    const was = this.#stalled;
    this.#stalled = null;
    return was;
  }

  /** Told once, when git is first stopped here; the company records it in its ledger. */
  onStall: (why: string) => void = () => {};

  constructor(dir: string, clock: Clock = systemClock, checkRoot: () => void = () => {}) {
    this.#dir = dir;
    this.#clock = clock;
    this.#checkRoot = checkRoot;
  }

  #git(args: string[], env?: Record<string, string>, confine?: string[]): string {
    // `safe.directory` on every call, not in a config file.
    //
    // The world lives on a bind mount, and the uid the host presents it under
    // is not always the uid the factory runs as. Git refuses a repo it thinks
    // belongs to someone else — "detected dubious ownership" — and that
    // refusal killed a whole shift mid-commit at 08:51 on a repo that was
    // readable a minute earlier and a minute later. The staff had already
    // learned to pass this in their own shell commands; the code that commits
    // on their behalf had not.
    //
    // Per-invocation rather than `git config --global`: HOME here is a tmpfs,
    // so a config written into it is gone on the next restart, and a control
    // that survives only until reboot is not a control.
    this.#vet();
    const argv = [...INERT, '-c', `safe.directory=${this.#dir}`, '-C', this.#dir, ...args];
    return this.#bounded(`git ${args[0]}`, () => execFileSync(confine ? 'bwrap' : 'git', confine ? [...confine, '--', 'git', ...argv] : argv, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: args[0] === 'add' ? GIT_ADD_TIMEOUT_MS : GIT_TIMEOUT_MS,
      // Capture stderr rather than inheriting it. Several calls here are
      // probes whose failure is expected and handled — notably the
      // "is this already a repo?" check on a directory that is not one yet.
      // Inheriting would print `fatal: not a git repository` on every first
      // run and make a healthy bootstrap look broken.
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(env ? { env: { ...process.env, ...env } } : {}),
    }).trim());
  }

  #bounded<T>(what: string, run: () => T): T {
    try {
      return run();
    } catch (e) {
      if (!timedOut(e)) throw e;
      this.#stalled = `${what} timed out; something in the repository blocks git (a FIFO among the ` +
        'objects, say) or a very large drop outran the bound. Once it is dealt with, ' +
        'POST /api/companies/<slug>/git/clear.';
      this.onStall(this.#stalled);
      throw new Error(`refusing to run git in ${this.#dir}: ${this.#stalled}`);
    }
  }

  /**
   * Refuse to run git in a repository that could make it run something, or
   * reach past the company. See untrustedRepo. Every call, not cached: a
   * cache keyed on file metadata can be matched by a rewrite, and one config
   * listing costs little beside the git call it guards.
   */
  #vet(): void {
    if (this.#stalled) throw new Error(`refusing to run git in ${this.#dir}: ${this.#stalled}`);
    this.#checkRoot();
    const why = this.#bounded('the repository vet', () => untrustedRepo(this.#dir));
    if (why) throw new Error(`refusing to run git in ${this.#dir}: ${why}`);
  }

  init(): void {
    // `rev-parse --git-dir` WALKS UP. When world/ sits inside another repo it
    // reports the ancestor's git dir, so "am I a repo?" answers yes for a
    // directory that has never been initialised — and every subsequent commit
    // lands in the parent repo instead. Compare the toplevel to our own path.
    try {
      const top = this.#git(['rev-parse', '--show-toplevel']);
      if (realpathSync(top) === realpathSync(this.#dir)) return;
    } catch {
      // Not inside any repo. Fall through and initialise.
    }
    this.#git(['init', '-q', '-b', 'main']);
    this.#git(['config', 'user.name', 'Riff']);
    this.#git(['config', 'user.email', 'riff@localhost']);
    this.#ignoreDroppings();
  }

  /**
   * The world's git log is the company's record of what it did, and every
   * artifact count is drawn from it. Finder writes .DS_Store into any folder
   * someone opens, and `git add -A` picks them up — so the operator browsing
   * the world in a file manager silently authors commits in the staff's name
   * and inflates the created-artifact count they are measured on.
   */
  #ignoreDroppings(): void {
    const path = join(this.#dir, '.gitignore');
    if (lexists(path)) return;
    writeWithin(this.#dir, path, ['.DS_Store', 'Thumbs.db', 'desktop.ini', ''].join('\n'));
    // Committed here rather than left in the tree: an uncommitted file is
    // swept up by whoever commits next, and infrastructure must not land in a
    // staff member's name or count toward what they made.
    this.#git(['add', '.gitignore']);
    this.#git([
      '-c', 'user.name=Riff', '-c', 'user.email=riff@localhost',
      'commit', '-q', '-m', 'Ignore what the operating system drops here',
    ]);
  }

  /**
   * A pathspec for the whole world less every nested repository. See nestedRepos.
   *
   * Only the ones the world does not already ignore: `git add` refuses any
   * pathspec that names an ignored path, exclusions included, and ignored ones
   * are never added anyway. From the 00:42 deploy on 2026-09-22 until this, every
   * shift's commit in ShipIt threw on one gitignored leftover worktree.
   */
  #scope(): string[] {
    const { nested, special } = worldTree(this.#dir);
    if (special) throw new Error(`refusing to run git in ${this.#dir}: world/${special} is neither a file nor a folder, and git would wait on it`);
    const ignored = this.#ignored(nested);
    return ['--', '.', ...nested.filter((r) => !ignored.has(r)).map((r) => `:(exclude,literal)${r}`)];
  }

  #ignored(paths: string[]): Set<string> {
    if (!paths.length) return new Set();
    try {
      // `./` first: the names are the staff's, and a leading `:(...)` is
      // pathspec magic, which check-ignore refuses outright — one oddly named
      // directory would stop every commit. It echoes each path as given.
      return new Set(this.#git(['check-ignore', '--', ...paths.map((r) => `./${r}`)])
        .split('\n').filter(Boolean).map((r) => r.replace(/^\.\//, '')));
    } catch (e) {
      // check-ignore answers 1 when nothing it was given is ignored.
      if ((e as { status?: number }).status === 1) return new Set();
      throw e;
    }
  }

  isDirty(): boolean {
    return this.#git(['status', '--porcelain', '--ignore-submodules=all', ...this.#scope()]).length > 0;
  }

  /**
   * Ensure a pattern is gitignored, committing the .gitignore change itself as
   * infrastructure if it had to be added.
   *
   * Same reasoning as #ignoreDroppings: an operator's pasted attachment must
   * never be swept into a staff member's commit by the next `add -A`, nor
   * counted toward the artifacts they made. Committed via a pathspec so only
   * .gitignore lands, whatever else happens to be in the index.
   */
  ignore(pattern: string): void {
    const path = join(this.#dir, '.gitignore');
    // A shift can make .gitignore a link to another company's config.json;
    // read through it and the append below would be written there. A link
    // reads as nothing here, and the write refuses it.
    const cur = readWithin(this.#dir, path) ?? '';
    if (cur.split('\n').some((l) => l.trim() === pattern)) return;
    writeWithin(this.#dir, path, (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + pattern + '\n');
    this.#git(['add', '.gitignore']);   // works whether it is new or already tracked
    this.#git([
      '-c', 'user.name=Riff', '-c', 'user.email=riff@localhost',
      'commit', '-q', '-m', `Ignore ${pattern}`, '--', '.gitignore',
    ]);
  }

  /**
   * Commit whatever the staff member just changed, in their name.
   * Returns the sha, or null when there was nothing to record.
   */
  commitAs(actor: { id: string; name: string }, message: string): string | null {
    const scope = this.#scope();
    this.#git(['add', '-A', ...scope]);
    const staged = this.#git(['diff', '--cached', '--name-only', '--ignore-submodules=all', ...scope]);
    if (!staged) return null;

    const at = this.#clock.now().toISOString();
    this.#git([
      '-c', `user.name=${actor.name}`,
      '-c', `user.email=${actor.id}@riff.local`,
      'commit', '-q', '-m', message,
    ], { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at });
    return this.#git(['rev-parse', 'HEAD']);
  }

  /**
   * Forget linked worktrees whose checkout is gone.
   *
   * The staff cannot do this themselves: the shift sandbox mounts each
   * `.git/worktrees/<name>` read-only piece by piece, so `git worktree prune`
   * from a shift answers EBUSY, and every worktree they removed left its entry
   * behind — 25 in ShipIt on 2026-09-22, with more after every run of its
   * commit hook. Two hours of grace: a worktree checked out in a shift's
   * private /tmp is invisible from here and would read as gone, and no shift
   * lives that long. A locked worktree is kept, as git always keeps it.
   *
   * `confine` is the bubblewrap view to run it in (cliConfinement). Prune
   * deletes stale entries recursively, and the vet's link check is a moment
   * before git walks: a colleague's shell still running could plant a link in
   * between. Inside the company's own view, whatever a link names resolves
   * within the company — and whether a path exists is answered there too.
   */
  pruneWorktrees(confine?: string[]): void {
    this.#git(['worktree', 'prune', '--expire=2.hours.ago'], undefined, confine);
  }

  /**
   * "What did they do while I was gone?" — e.g. since('3.days').
   *
   * The author email carries the agent id (`<id>@riff.local`), which is the
   * only reliable key: display names collide, and the email domain has already
   * changed once under a company that kept working across the change.
   *
   * `until` closes the window at the far end, which only a report comparing
   * one week against the one before it needs; a reader asking what happened
   * lately wants everything up to now and leaves it off.
   */
  since(when: string, until?: string):
      Array<{ sha: string; author: string; email: string; at: string; subject: string }> {
    const out = this.#git(['log', `--since=${when}`, ...(until ? [`--until=${until}`] : []),
      '--pretty=format:%h%x00%an%x00%ae%x00%aI%x00%s']);
    if (!out) return [];
    return out.split('\n').map((line) => {
      const [sha = '', author = '', email = '', at = '', subject = ''] = line.split('\0');
      return { sha, author, email, at, subject };
    });
  }

  /** Per-author change counts — the honest version of "who did the work". */
  contributionsSince(when: string, until?: string): Array<{ author: string; commits: number }> {
    const out = this.#git(['shortlog', '-sn', '--all', `--since=${when}`,
      ...(until ? [`--until=${until}`] : [])]);
    if (!out) return [];
    return out.split('\n').map((l) => {
      const m = /^\s*(\d+)\s+(.*)$/.exec(l);
      return { author: m?.[2] ?? l.trim(), commits: Number(m?.[1] ?? 0) };
    });
  }

  /**
   * Commits touching one path inside a window.
   *
   * Per-path rather than parsing --name-only over the whole log: a project is
   * a directory and git already answers "what happened in this directory"
   * exactly, where reconstructing it from file lists has to guess at renames.
   * The caller asks about a handful of projects, not thousands of files.
   */
  commitsTouching(path: string, when: string, until?: string): number {
    const out = this.#git(['log', `--since=${when}`, ...(until ? [`--until=${until}`] : []),
      '--pretty=format:%h', '--', path]);
    return out ? out.split('\n').filter(Boolean).length : 0;
  }

  /**
   * When a path was first committed, ever — not inside a window.
   *
   * The age of the newest project is a fact about the company's history, and
   * a window-bounded answer would report a five-week-old project as new the
   * first time anyone touched it in a fresh week.
   */
  firstCommitAt(path: string): string | null {
    const out = this.#git(['log', '--reverse', '--pretty=format:%aI', '--', path]);
    return out ? (out.split('\n')[0] ?? null) : null;
  }

  diffOf(sha: string): string {
    return this.#git(['show', '--stat', '--pretty=format:%an %s', sha]);
  }
}
