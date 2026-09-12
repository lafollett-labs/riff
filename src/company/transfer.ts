import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { companiesDir, companyHome, installRoot, operatorError, persisted, slugId,
  type RiffConfig } from '../core/config.ts';
import { atomicWriteFileSync } from '../core/atomicwrite.ts';

/**
 * Moving a company between machines.
 *
 * A company is a directory: a config, a SQLite ledger and a world that is
 * itself a git repository. All of that travels, history included — an export
 * you cannot `git log` is a screenshot, not a company. What does not travel is
 * anything about the machine it came from: the absolute paths in the config
 * are rewritten on arrival, and it always lands paused.
 *
 * tar rather than zip because tar is on every machine that can run this, and
 * is already in the container image — node:26-slim carries GNU tar 1.35 and
 * gzip. `zip` is not there, and adding it would be a package to keep for the
 * sake of a file extension.
 */

/** Bumped only when an older Riff could not read what a newer one writes. */
const FORMAT = 1;
const MANIFEST = 'riff.json';

/**
 * A tarball entry count no honest company reaches. The archive arrived from
 * someone else, so it gets treated as data rather than as a promise.
 */
const MAX_ENTRIES = 50_000;

export type Manifest = {
  format: number;
  slug: string;
  name: string;
  business: string;
  exportedAt: string;
  counts: { agents: number; events: number; commons: number };
};

// stderr is captured rather than inherited: every caller turns a tar failure
// into a sentence the operator can act on, and "Unrecognized archive format"
// landing in the server log next to it explains nothing twice.
const tar = (args: string[]): string =>
  execFileSync('tar', args, {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });

/** Staging sits inside the installation so the final move is a rename, not a copy. */
const staging = (what: string): string => {
  const dir = join(installRoot(), '.transfer');
  mkdirSync(dir, { recursive: true });
  return mkdtempSync(join(dir, what + '-'));
};

const readConfig = (home: string): RiffConfig =>
  JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as RiffConfig;

// --------------------------------------------------------------------- out

/**
 * Write one company to a single file.
 *
 * The ledger is copied with VACUUM INTO rather than read off disk: the
 * database may be open and mid-write, and its WAL holds pages the main file
 * does not. VACUUM INTO takes a consistent snapshot into one file with no
 * sidecars, which is exactly what belongs in an archive.
 */
export const exportCompany = (slug: string, outPath: string): Manifest => {
  const home = companyHome(slug);
  if (!existsSync(home)) throw operatorError(`No company '${slug}' on this installation.`);

  const work = staging('export');
  try {
    const cfg = readConfig(home);
    cpSync(join(home, 'config.json'), join(work, 'config.json'));

    const src = new DatabaseSync(join(home, 'ledger.db'), { readOnly: true });
    let counts = { agents: 0, events: 0, commons: 0 };
    try {
      const one = (sql: string): number => Number((src.prepare(sql).get() as { n: unknown }).n);
      counts = {
        agents: one('SELECT COUNT(*) n FROM agents'),
        events: one('SELECT COUNT(*) n FROM events'),
        commons: 0,
      };
      src.exec(`VACUUM INTO '${join(work, 'ledger.db').replace(/'/g, "''")}'`);
    } finally { src.close(); }

    // Strip what only meant something on this machine.
    //
    // `session:<agent>` points at a conversation held by the runtime, which in
    // the container is a tmpfs. It is meaningless on the machine the company
    // is going to — and worse than meaningless, because resuming a transcript
    // that was never there fails every shift on arrival. The same mistake as
    // storing absolute paths in config.json, in a different table.
    const copy = new DatabaseSync(join(work, 'ledger.db'));
    try { copy.exec("DELETE FROM meta WHERE key LIKE 'session:%'"); }
    finally { copy.close(); }

    if (existsSync(join(home, 'world'))) {
      // node_modules is regenerable, enormous, and the only thing in a world
      // that routinely contains symlinks — which the importer refuses.
      cpSync(join(home, 'world'), join(work, 'world'), {
        recursive: true, verbatimSymlinks: true,
        filter: (from) => basename(from) !== 'node_modules',
      });
      const commons = join(work, 'world', 'commons');
      if (existsSync(commons)) {
        const walk = (d: string): number => readdirSync(d).reduce((n, f) => {
          const p = join(d, f);
          return n + (statSync(p).isDirectory() ? walk(p) : (f.endsWith('.md') ? 1 : 0));
        }, 0);
        counts.commons = walk(commons);
      }
    }

    const manifest: Manifest = {
      format: FORMAT,
      slug,
      name: cfg.company.name,
      business: cfg.company.business,
      exportedAt: new Date().toISOString(),
      counts,
    };
    writeFileSync(join(work, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    mkdirSync(join(outPath, '..'), { recursive: true });
    tar(['-czf', outPath, '-C', work, '.']);
    return manifest;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

/** What an exported file should be called. Safe as a filename on every OS. */
export const exportName = (slug: string, at = new Date()): string =>
  `${slug}-${at.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.riff.tar.gz`;

// ---------------------------------------------------------------------- in

/**
 * Every path in the archive, refused unless it stays inside the directory it
 * is about to be extracted into.
 *
 * This runs BEFORE extraction, not after. `../../.ssh/authorized_keys` is a
 * perfectly legal tar member, and by the time you notice it in the output
 * directory it is already written somewhere else.
 */
const checkedEntries = (archive: string): string[] => {
  let listing: string;
  try { listing = tar(['-tzf', archive]); }
  catch { throw operatorError('That file is not a Riff export (it is not a readable .tar.gz).'); }

  const entries = listing.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!entries.length) throw operatorError('That archive is empty.');
  if (entries.length > MAX_ENTRIES) {
    throw operatorError(`That archive holds ${entries.length} files, which is more than an exported company should.`);
  }
  for (const e of entries) {
    const p = e.replace(/^\.\//, '');
    if (p.startsWith('/') || /^[a-zA-Z]:/.test(p) || p.split(/[/\\]/).includes('..')) {
      throw operatorError(`Refusing that archive: it writes outside the company directory (${e}).`);
    }
  }
  return entries;
};

/** A world that arrived containing links is a world that can read outside itself. */
const refuseLinks = (dir: string): void => {
  const walk = (d: string): void => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) {
        throw operatorError(
          `Refusing that archive: ${p.slice(dir.length + 1)} is a symbolic link, and a link ` +
          `inside a world can point at files the company is not allowed to read.`,
        );
      }
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
};

/**
 * Read a company out of a file and give it a home here.
 *
 * The imported company always lands paused. Someone else's company starting to
 * spend your subscription the moment it finishes copying is not a feature.
 */
export const importCompany = (
  archive: string, opts: { name?: string; slug?: string } = {},
): { slug: string; manifest: Manifest; renamed: boolean } => {
  if (!existsSync(archive)) throw operatorError(`No such file: ${archive}`);
  checkedEntries(archive);

  const work = staging('import');
  let landed = false;
  try {
    tar(['-xzf', archive, '-C', work, '--no-same-owner']);
    refuseLinks(work);

    const manifestPath = join(work, MANIFEST);
    if (!existsSync(manifestPath)) {
      throw operatorError('That archive is not a Riff export — it has no riff.json.');
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    if (!Number.isFinite(manifest.format) || manifest.format > FORMAT) {
      throw operatorError(
        `That export was written by a newer Riff (format ${manifest.format}; this one reads ${FORMAT}).`,
      );
    }
    if (!existsSync(join(work, 'config.json')) || !existsSync(join(work, 'ledger.db'))) {
      throw operatorError('That archive is missing a config or a ledger — it is not a whole company.');
    }

    // Whatever it was called over there, it must not land on top of anything
    // here. A collision gets a suffix rather than an error: the operator asked
    // for this company, and refusing to import it is not a safer answer.
    const wanted = slugId(opts.slug?.trim() || opts.name?.trim() || manifest.slug);
    let slug = wanted;
    for (let n = 2; existsSync(companyHome(slug)); n++) slug = `${wanted}-${n}`;
    const renamed = slug !== manifest.slug;

    // A config written by an older Riff states where it used to live. Those
    // paths describe someone else's disk, so they are dropped rather than
    // rewritten — a company is located by the directory it is in.
    const home = companyHome(slug);
    const cfg = JSON.parse(readFileSync(join(work, 'config.json'), 'utf8')) as RiffConfig;
    const next: RiffConfig = {
      ...cfg,
      home,
      worldDir: join(home, 'world'),
      ledgerPath: join(home, 'ledger.db'),
      company: {
        name: opts.name?.trim() || cfg.company.name,
        business: cfg.company.business,
      },
      running: false,
    };
    atomicWriteFileSync(join(work, 'config.json'), JSON.stringify(persisted(next), null, 2) + '\n');
    rmSync(manifestPath, { force: true });

    // Belt and braces: an archive written before exports learned to strip
    // these still carries them, and it must not brick every shift on arrival.
    const arriving = new DatabaseSync(join(work, 'ledger.db'));
    try { arriving.exec("DELETE FROM meta WHERE key LIKE 'session:%'"); }
    catch { /* an older schema without meta is still importable */ }
    finally { arriving.close(); }

    mkdirSync(companiesDir(), { recursive: true });
    renameSync(work, home);
    landed = true;
    return { slug, manifest, renamed };
  } finally {
    if (!landed) rmSync(work, { recursive: true, force: true });
  }
};

/** Read the manifest without unpacking anything. Used to show what is in a file. */
export const peek = (archive: string): Manifest | null => {
  try {
    checkedEntries(archive);
    return JSON.parse(tar(['-xzOf', archive, `./${MANIFEST}`])) as Manifest;
  } catch { return null; }
};

export { FORMAT as TRANSFER_FORMAT, MANIFEST as TRANSFER_MANIFEST };
