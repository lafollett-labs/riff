import { execFileSync } from 'node:child_process';
import { realpathSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
export class WorldGit {
  #dir: string;
  #clock: Clock;

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
  constructor(dir: string, clock: Clock = systemClock) {
    this.#dir = dir;
    this.#clock = clock;
  }

  #git(args: string[], env?: Record<string, string>): string {
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
    return execFileSync('git', ['-c', `safe.directory=${this.#dir}`, '-C', this.#dir, ...args], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      // Capture stderr rather than inheriting it. Several calls here are
      // probes whose failure is expected and handled — notably the
      // "is this already a repo?" check on a directory that is not one yet.
      // Inheriting would print `fatal: not a git repository` on every first
      // run and make a healthy bootstrap look broken.
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(env ? { env: { ...process.env, ...env } } : {}),
    }).trim();
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
    if (existsSync(path)) return;
    writeFileSync(path, ['.DS_Store', 'Thumbs.db', 'desktop.ini', ''].join('\n'), 'utf8');
    // Committed here rather than left in the tree: an uncommitted file is
    // swept up by whoever commits next, and infrastructure must not land in a
    // staff member's name or count toward what they made.
    this.#git(['add', '.gitignore']);
    this.#git([
      '-c', 'user.name=Riff', '-c', 'user.email=riff@localhost',
      'commit', '-q', '-m', 'Ignore what the operating system drops here',
    ]);
  }

  isDirty(): boolean {
    return this.#git(['status', '--porcelain']).length > 0;
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
    const cur = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (cur.split('\n').some((l) => l.trim() === pattern)) return;
    writeFileSync(path, (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + pattern + '\n', 'utf8');
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
    this.#git(['add', '-A']);
    const staged = this.#git(['diff', '--cached', '--name-only']);
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
