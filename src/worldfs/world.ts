import { mkdirSync, existsSync, readdirSync, statSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join, resolve, sep, dirname, relative } from 'node:path';
import { parse, stringify, field, type Doc, type Frontmatter } from './frontmatter.ts';
import { WorldGit } from './git.ts';
import { inside, lexists, readWithin, unlinkWithin, writeWithin } from './within.ts';
import { slug } from '../core/ids.ts';
import { systemClock, type Clock } from '../core/clock.ts';
import type { AgentId } from '../core/types.ts';
import type { Ledger } from '../ledger/ledger.ts';

/**
 * world/ — the staff-authored half of a company.
 *
 *   world/
 *     house-rules.md            the five rules, readable by everyone
 *     staff/<id>/
 *       persona.md              their brief. Colleagues CAN read this.
 *       memory.md               consolidated long-term memory
 *       journal/<date>.md       what they did, per day
 *       notes/<date>-<who>.md   what they think of a colleague
 *       drafts/                 outbound work waiting on you
 *     commons/                  shared ground. Anything they invent lands here.
 *
 * There is no schema for commons/. That is the point: a morale meter nobody
 * asked for can only appear if inventing new state costs no migration.
 */
/**
 * Agents pass commons paths both ways — 'doctrine/seats.md' and
 * 'commons/doctrine/seats.md' mean the same shelf. Every caller normalizes
 * through here so the write path and the gate can never disagree about
 * where a document lives.
 */
export const commonsPath = (rel: string): string =>
  `commons/${rel.replace(/^\/+/, '').replace(/^(?:commons\/)+/, '')}`;

export class World {
  #root: string;
  #clock: Clock;
  git: WorldGit;

  /** The company's own bubblewrap view, when there is one; see removeProject. */
  #confine: (() => string[]) | undefined;

  constructor(root: string, clock: Clock = systemClock, confine?: () => string[]) {
    this.#root = resolve(root);
    this.#clock = clock;
    this.#confine = confine;
    this.git = new WorldGit(this.#root, clock, () => this.#assertRoot());
  }

  /** The directory world/ was when this company opened, by inode. */
  #rootIno: number | null = null;

  /**
   * world/ must still be the real directory it was when the company opened.
   *
   * The company home is writable from a shift's shell (a coding company keeps
   * its toolchain there), so the directory named world/ could be moved aside and
   * replaced. Everything the gateway does resolves through this path — file
   * reads, the gate's realpath check, a shift's cwd, every commit — and the
   * gateway runs outside the sandbox that hides the other companies. A link or
   * a stranger directory here would be followed, so either is refused.
   */
  #assertRoot(): void {
    let st;
    try { st = lstatSync(this.#root); } catch { return; }   // not made yet: nothing to follow
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`world is no longer a directory: ${this.#root}`);
    }
    if (this.#rootIno === null) this.#rootIno = st.ino;
    else if (st.ino !== this.#rootIno) throw new Error(`world was replaced: ${this.#root}`);
  }

  get root(): string { this.#assertRoot(); return this.#root; }

  /**
   * Resolve a staff-supplied relative path, refusing anything that escapes
   * world/. Staff choose these strings, so this is a trust boundary: symlinks
   * and `..` are both handled by comparing the REALPATH prefix, not the text.
   */
  path(rel: string): string {
    const abs = resolve(this.root, rel);

    // 1. Textual check — kills `../../etc/passwd` and absolute paths.
    if (abs !== this.root && !abs.startsWith(this.root + sep)) {
      throw new Error(`path escapes the world: ${rel}`);
    }

    // 2. Symlink check — a link planted INSIDE world/ resolves textually
    //    clean but lands outside. Walk up to the deepest ancestor that
    //    actually exists (the target itself may be a file we are about to
    //    create) and compare real paths. "Exists" is lstat's answer: a link
    //    to a file not made yet is not there to existsSync, so the walk used
    //    to step past it and vet the parent — and the write then followed it
    //    into another company. A link that resolves to nothing is refused.
    let probe = abs;
    while (!lexists(probe) && dirname(probe) !== probe) probe = dirname(probe);
    let real: string;
    try { real = realpathSync(probe); } catch { throw new Error(`path escapes the world via symlink: ${rel}`); }
    if (!inside(realpathSync(this.root), real)) {
      throw new Error(`path escapes the world via symlink: ${rel}`);
    }
    return abs;
  }

  /**
   * A folder to list, or null. A listing that starts at a link lists whatever
   * it names: commons/ linked to a neighbour's gave its document names to
   * commons_index, and projects/ its project names to portfolio.
   */
  #dirAt(rel: string): string | null {
    let abs: string;
    try { abs = this.path(rel); } catch { return null; }
    return lexists(abs) && lstatSync(abs).isDirectory() ? abs : null;
  }

  ensure(): void {
    mkdirSync(this.root, { recursive: true });
    for (const d of ['staff', 'commons', 'commons/bulletin']) {
      mkdirSync(this.path(d), { recursive: true });
    }
    this.git.init();
  }

  ensureStaff(id: AgentId): void {
    mkdirSync(this.root, { recursive: true });
    for (const d of ['journal', 'notes', 'drafts']) {
      mkdirSync(this.path(join('staff', slug(id), d)), { recursive: true });
    }
  }

  // ------------------------------------------------------------- documents
  exists(rel: string): boolean { return existsSync(this.path(rel)); }

  readDoc(rel: string): Doc | null {
    const text = readWithin(this.root, this.path(rel));
    return text === null ? null : parse(text);
  }

  /**
   * Write a document, absorbing any frontmatter the author put in the body.
   *
   * Staff write markdown the way people write markdown — which means they open
   * with a `---` block. Without this, their fence and ours stack, the parser
   * reads only the first, and the second becomes prose in the middle of the
   * page. Their keys fill gaps; ours win on conflict, since ours are the ones
   * the company relies on.
   */
  writeDoc(rel: string, doc: Doc): void {
    const abs = this.path(rel);

    const inner = parse(doc.body);
    const merged: Doc = Object.keys(inner.data).length
      ? { data: { ...inner.data, ...doc.data }, body: inner.body }
      : doc;

    writeWithin(this.root, abs, stringify(merged));
  }

  readText(rel: string): string | null {
    return readWithin(this.root, this.path(rel));
  }

  // ----------------------------------------------------------- staff files
  personaPath = (id: AgentId): string => `staff/${slug(id)}/persona.md`;
  memoryPath = (id: AgentId): string => `staff/${slug(id)}/memory.md`;

  readPersona(id: AgentId): string {
    return this.readDoc(this.personaPath(id))?.body.trim() ?? '';
  }

  readMemory(id: AgentId): string {
    return this.readDoc(this.memoryPath(id))?.body.trim() ?? '';
  }

  writeMemory(id: AgentId, body: string): void {
    this.writeDoc(this.memoryPath(id), {
      data: { agent: id, updated: this.#clock.iso() },
      body: body.endsWith('\n') ? body : body + '\n',
    });
  }

  appendJournal(id: AgentId, entry: string): void {
    const rel = `staff/${slug(id)}/journal/${this.#clock.day()}.md`;
    const prior = this.readDoc(rel);
    const stamp = this.#clock.now().toISOString().slice(11, 16);
    const body = `${prior?.body.trimEnd() ?? `# ${this.#clock.day()}`}\n\n- **${stamp}** ${entry}\n`;
    this.writeDoc(rel, { data: { agent: id, day: this.#clock.day() }, body });
  }

  // ----------------------------------------------------------------- notes
  /**
   * One staff member's note about another. These are the 742-notes mechanic:
   * plain files, no schema, and cheap enough that they actually get written.
   */
  writeNote(author: AgentId, subject: AgentId | null, title: string, body: string): string {
    const rel = `staff/${slug(author)}/notes/${this.#clock.day()}-${slug(subject ?? title)}.md`;
    const prior = this.readDoc(rel);
    const stamp = this.#clock.iso();
    const merged = prior
      ? `${prior.body.trimEnd()}\n\n---\n\n## ${stamp}\n\n${body.trim()}\n`
      : `${body.trim()}\n`;
    this.writeDoc(rel, {
      data: {
        author,
        ...(subject ? { subject } : {}),
        title,
        written_at: field(prior?.data ?? {}, 'written_at') ?? stamp,
        updated_at: stamp,
      },
      body: merged,
    });
    return rel;
  }

  /**
   * Rebuild the ledger's note index by walking the filesystem.
   * The index is derived and disposable; these files are the truth.
   */
  reindexNotes(ledger: Ledger): number {
    ledger.clearNoteIndex();
    let n = 0;
    const staffDir = this.#dirAt('staff');
    if (!staffDir) return 0;

    for (const who of readdirSync(staffDir)) {
      // A staff folder that is a link would index another company's notes.
      if (!lstatSync(join(staffDir, who)).isDirectory()) continue;
      const notes = join(staffDir, who, 'notes');
      if (!existsSync(notes) || !lstatSync(notes).isDirectory()) continue;
      for (const f of readdirSync(notes)) {
        if (!f.endsWith('.md')) continue;
        const abs = join(notes, f);
        const doc = this.readDoc(relative(this.root, abs));
        if (!doc) continue;
        ledger.indexNote({
          path: relative(this.root, abs),
          author: field(doc.data, 'author') ?? who,
          subject: field(doc.data, 'subject'),
          title: field(doc.data, 'title') ?? f.replace(/\.md$/, ''),
          writtenAt: field(doc.data, 'written_at') ?? this.#clock.iso(),
        });
        n++;
      }
    }
    return n;
  }

  // ---------------------------------------------------------------- commons
  /** Shared ground. No schema, deliberately. */
  writeCommons(rel: string, data: Frontmatter, body: string): string {
    const path = commonsPath(rel);
    this.writeDoc(path, { data, body });
    return path;
  }

  listCommons(): string[] {
    const dir = this.#dirAt('commons');
    if (!dir) return [];
    const out: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const abs = join(d, f);
        // lstat: a folder that is a link would walk another company's tree.
        if (lstatSync(abs).isDirectory()) walk(abs);
        else if (f.endsWith('.md')) out.push(relative(this.root, abs));
      }
    };
    walk(dir);
    return out.sort();
  }

  /** Delete a document. The counterpart to R6: a ceiling with no way to
   *  remove would just be a wall. */
  remove(rel: string): void {
    unlinkWithin(this.root, this.path(rel));
  }

  commonsCount(): number { return this.listCommons().length; }

  /**
   * What the company is carrying, for R7.
   *
   * A project is a directory directly under `projects/`. Nothing declares
   * one — it exists because somebody wrote a file into it, which is how they
   * actually begin. Dotfiles are skipped so a stray `.DS_Store` or a
   * scratch `.work-mut-*` never counts as work.
   */
  listProjects(): string[] {
    const dir = this.#dirAt('projects');
    if (!dir) return [];
    return readdirSync(dir)
      .filter((f) => !f.startsWith('.') && lstatSync(join(dir, f)).isDirectory())
      .sort();
  }

  projectCount(): number { return this.listProjects().length; }

  /**
   * Retire a project: the counterpart to R7, as remove() is to R6.
   *
   * Recursive, unlike remove(), because a project is a tree and rmSync on a
   * directory without it throws rather than refusing — a ceiling whose only
   * escape hatch errors is a wall.
   */
  removeProject(name: string): boolean {
    // Never let a name climb out of projects/. The gate classifies paths, but
    // this is reachable from a tool argument and must not depend on that.
    if (!name || name.startsWith('.') || name.includes('/') || name.includes('\\')) return false;
    // Through path(), or a projects/ that is a link takes the recursive
    // delete into whatever it points at.
    const abs = this.path(`projects/${name}`);
    if (!existsSync(abs)) return false;
    // A check is a moment old by the time a tree is walked, and the CEO seat
    // retires projects in its own shift, so it picks the moment: projects/
    // swapped for a link to /data/companies/<other> after the check, and a
    // project named "world", deletes a neighbour's world. Inside the
    // company's own view every link resolves within the company, whatever it
    // says. Off the container there is no view and no shell to race.
    const confine = this.#confine?.();
    if (confine) execFileSync('bwrap', [...confine, '--', 'rm', '-rf', '--', abs], { stdio: ['ignore', 'ignore', 'pipe'] });
    else rmSync(abs, { recursive: true, force: true });
    return true;
  }

  // ------------------------------------------------------------ attachments
  /**
   * Store an operator-supplied image (pasted or chosen while composing a
   * message) and return its world-relative path, which a message body then
   * references as `![image](<path>)` and /api/file serves back.
   *
   * `attachments/` is gitignored, not committed: an attachment is operator
   * metadata for a message, not staff-authored work, so it must not appear in
   * the world's history, inflate anyone's artifact count, or be swept into a
   * staff commit by `add -A`. The random name keeps two pastes in one day from
   * colliding; `ext` comes from the server sniffing the bytes, never the client.
   */
  writeAttachment(bytes: Buffer, ext: string): string {
    this.git.ignore('attachments/');
    const rel = `attachments/${this.#clock.day()}-${randomBytes(6).toString('hex')}.${ext}`;
    writeWithin(this.root, this.path(rel), bytes);
    return rel;
  }

  listDrafts(id: AgentId): string[] {
    const dir = this.#dirAt(join('staff', slug(id), 'drafts'));
    if (!dir) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => `staff/${slug(id)}/drafts/${f}`);
  }
}
