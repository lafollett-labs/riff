import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, realpathSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve, sep, dirname, relative } from 'node:path';
import { parse, stringify, field, type Doc, type Frontmatter } from './frontmatter.ts';
import { WorldGit } from './git.ts';
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

  constructor(root: string, clock: Clock = systemClock) {
    this.#root = resolve(root);
    this.#clock = clock;
    this.git = new WorldGit(this.#root, clock);
  }

  get root(): string { return this.#root; }

  /**
   * Resolve a staff-supplied relative path, refusing anything that escapes
   * world/. Staff choose these strings, so this is a trust boundary: symlinks
   * and `..` are both handled by comparing the REALPATH prefix, not the text.
   */
  path(rel: string): string {
    const abs = resolve(this.#root, rel);

    // 1. Textual check — kills `../../etc/passwd` and absolute paths.
    if (abs !== this.#root && !abs.startsWith(this.#root + sep)) {
      throw new Error(`path escapes the world: ${rel}`);
    }

    // 2. Symlink check — a link planted INSIDE world/ resolves textually
    //    clean but lands outside. Walk up to the deepest ancestor that
    //    actually exists (the target itself may be a file we are about to
    //    create) and compare real paths.
    let probe = abs;
    while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
    const real = realpathSync(probe);
    const realRoot = realpathSync(this.#root);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new Error(`path escapes the world via symlink: ${rel}`);
    }
    return abs;
  }

  ensure(): void {
    for (const d of ['staff', 'commons', 'commons/bulletin']) {
      mkdirSync(join(this.#root, d), { recursive: true });
    }
    this.git.init();
  }

  ensureStaff(id: AgentId): void {
    for (const d of ['journal', 'notes', 'drafts']) {
      mkdirSync(join(this.#root, 'staff', slug(id), d), { recursive: true });
    }
  }

  // ------------------------------------------------------------- documents
  exists(rel: string): boolean { return existsSync(this.path(rel)); }

  readDoc(rel: string): Doc | null {
    const abs = this.path(rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) return null;
    return parse(readFileSync(abs, 'utf8'));
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
    mkdirSync(dirname(abs), { recursive: true });

    const inner = parse(doc.body);
    const merged: Doc = Object.keys(inner.data).length
      ? { data: { ...inner.data, ...doc.data }, body: inner.body }
      : doc;

    writeFileSync(abs, stringify(merged), 'utf8');
  }

  readText(rel: string): string | null {
    const abs = this.path(rel);
    return existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, 'utf8') : null;
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
    const staffDir = join(this.#root, 'staff');
    if (!existsSync(staffDir)) return 0;

    for (const who of readdirSync(staffDir)) {
      const notes = join(staffDir, who, 'notes');
      if (!existsSync(notes)) continue;
      for (const f of readdirSync(notes)) {
        if (!f.endsWith('.md')) continue;
        const abs = join(notes, f);
        const doc = parse(readFileSync(abs, 'utf8'));
        ledger.indexNote({
          path: relative(this.#root, abs),
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
    const dir = join(this.#root, 'commons');
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const abs = join(d, f);
        if (statSync(abs).isDirectory()) walk(abs);
        else if (f.endsWith('.md')) out.push(relative(this.#root, abs));
      }
    };
    walk(dir);
    return out.sort();
  }

  /** Delete a document. The counterpart to R6: a ceiling with no way to
   *  remove would just be a wall. */
  remove(rel: string): void {
    const abs = this.path(rel);
    if (existsSync(abs)) rmSync(abs, { force: true });
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
    const dir = join(this.#root, 'projects');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => !f.startsWith('.') && statSync(join(dir, f)).isDirectory())
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
    const abs = join(this.#root, 'projects', name);
    if (!existsSync(abs)) return false;
    rmSync(abs, { recursive: true, force: true });
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
    const abs = this.path(rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
    return rel;
  }

  listDrafts(id: AgentId): string[] {
    const dir = join(this.#root, 'staff', slug(id), 'drafts');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => `staff/${slug(id)}/drafts/${f}`);
  }
}
