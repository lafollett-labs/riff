import { closeSync, constants, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync,
  readFileSync, renameSync, unlinkSync, writeFileSync, type Dirent } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

const { O_RDONLY, O_WRONLY, O_CREAT, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = constants;

/** Whether a real path is the root or below it. */
export const inside = (realRoot: string, real: string): boolean =>
  real === realRoot || real.startsWith(realRoot + sep);

/** Whether anything, a dangling link included, sits at a path. */
export const lexists = (p: string): boolean => {
  try { lstatSync(p); return true; } catch { return false; }
};

const refused = (code: 'ELOOP' | 'ENOENT', what: string): Error =>
  Object.assign(new Error(`${code === 'ELOOP' ? 'refusing a link, or a file, on the way' : 'no such folder'}: ${what}`),
    { code });

/** A directory below a root, reached without following a link at any step. */
type Dir = {
  /** A name in this directory, as a path that resolves from it and nowhere else. */
  at: (name: string) => string;
  /** The directory itself, the same way. */
  self: string;
  close: () => void;
};

const PROC = existsSync('/proc/self/fd');

const fdDir = (fd: number): Dir =>
  ({ at: (name) => `/proc/self/fd/${fd}/${name}`, self: `/proc/self/fd/${fd}`, close: () => closeSync(fd) });
const pathDir = (path: string): Dir => ({ at: (name) => join(path, name), self: path, close: () => {} });

/** The folder `name` in `d`, made first if asked; a link or a file there is refused. */
const step = (d: Dir, name: string, create: boolean, what: string): Dir => {
  const next = d.at(name);
  if (!PROC) {
    let st;
    try { st = lstatSync(next); } catch {
      if (!create) throw refused('ENOENT', what);
      mkdirSync(next);
      return pathDir(next);
    }
    if (!st.isDirectory()) throw refused('ELOOP', what);
    return pathDir(next);
  }
  if (create) {
    try { mkdirSync(next); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  }
  try {
    return fdDir(openSync(next, O_RDONLY | O_DIRECTORY | O_NOFOLLOW));
  } catch (e) {
    // Linux answers a link here with ENOTDIR, not ELOOP.
    if ((e as NodeJS.ErrnoException).code === 'ENOTDIR') throw refused('ELOOP', what);
    throw e;
  }
};

/**
 * Reach `dir` from `root` one component at a time, following no link.
 *
 * The gateway works in worlds from outside every shift's view, on names a
 * shift chose, while that shift's shell can plant links; a path checked a
 * moment ago can be a link by the time it is used. Before this, a draft
 * written through a planted link landed in another company, a linked
 * projects/ took a recursive delete next door, and a FIFO at a journal's
 * name held the whole gateway on a synchronous open.
 *
 * On Linux, where the shells are, each step opens the next directory from the
 * descriptor of the last with O_NOFOLLOW — through `/proc/self/fd/<fd>/<name>`,
 * which resolves from that descriptor whatever its path now says, as openat
 * would. A swap after any check changes nothing: there is no path left to
 * re-point. Folders it has to make are made the same way, so not even an
 * empty one lands next door. Without /proc (the host, where no shell runs) the
 * same walk is done by path with lstat.
 */
const walk = (root: string, dir: string, create: boolean): Dir => {
  const rel = relative(root, dir);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`refusing to reach outside ${root}: ${dir}`);
  let d = PROC ? fdDir(openSync(root, O_RDONLY | O_DIRECTORY)) : pathDir(root);
  try {
    for (const name of rel ? rel.split(sep) : []) {
      const next = step(d, name, create, dir);
      d.close();
      d = next;
    }
  } catch (e) {
    d.close();
    throw e;
  }
  return d;
};

const within = <T>(root: string, dir: string, create: boolean, use: (d: Dir) => T): T => {
  const d = walk(root, dir, create);
  try { return use(d); } finally { d.close(); }
};

/** Open a regular file, refusing a link, a FIFO or anything else at the name. */
const openFile = (at: string, flags: number, what: string): number => {
  const fd = openSync(at, flags | O_NOFOLLOW | O_NONBLOCK, 0o644);
  if (fstatSync(fd).isFile()) return fd;
  closeSync(fd);
  throw new Error(`refusing something that is not a file: ${what}`);
};

/** The errors that mean "nothing readable is there": missing, a link, or not a folder on the way. */
const absent = (e: unknown): boolean =>
  ['ENOENT', 'ELOOP', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '');

/** Write a whole file below `root`, making its folders. */
export const writeWithin = (root: string, abs: string, data: string | Buffer): void =>
  within(root, dirname(abs), true, (d) => {
    const fd = openFile(d.at(basename(abs)), O_WRONLY | O_CREAT, abs);
    try { ftruncateSync(fd, 0); writeFileSync(fd, data); } finally { closeSync(fd); }
  });

/** Read a file below `root` as text; null if no regular file is reachable there. */
export const readWithin = (root: string, abs: string): string | null => {
  try {
    return within(root, dirname(abs), false, (d) => {
      const fd = openSync(d.at(basename(abs)), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      try { return fstatSync(fd).isFile() ? readFileSync(fd, 'utf8') : null; } finally { closeSync(fd); }
    });
  } catch (e) {
    // A link at the name is not a document: throwing would let one planted
    // link fail every wake that reads memory.md, or /api/commons for the
    // whole company.
    if (absent(e)) return null;
    throw e;
  }
};

/** Open a regular file below `root` for reading; the caller owns the descriptor. */
export const openWithin = (root: string, abs: string): number =>
  within(root, dirname(abs), false, (d) => openFile(d.at(basename(abs)), O_RDONLY, abs));

/** Remove one file below `root`. A link there is removed, never followed. */
export const unlinkWithin = (root: string, abs: string): void => {
  try {
    within(root, dirname(abs), false, (d) => unlinkSync(d.at(basename(abs))));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
};

/** Make a folder and its parents below `root`. */
export const mkdirWithin = (root: string, abs: string): void => within(root, abs, true, () => {});

/** A folder's entries, typed without following them; null if no folder is reachable there. */
export const listWithin = (root: string, abs: string): Dirent[] | null => {
  try {
    return within(root, abs, false, (d) => readdirSync(d.self, { withFileTypes: true }));
  } catch (e) {
    if (absent(e)) return null;
    throw e;
  }
};

/**
 * Every regular file below a folder that `keep` accepts, as paths relative to
 * it; null if no folder is reachable there. Descends through no link and no
 * more than `depth` folders down, each from its parent's descriptor.
 *
 * Re-walking from the root at every level cost a tree d deep about d²/2
 * opens, synchronous on the loop every company shares, and one descriptor
 * per level has no PATH_MAX to stop it: ten thousand nested folders under
 * commons/ would have stalled the gateway for minutes.
 */
export const filesWithin = (root: string, abs: string, depth: number, keep: (name: string) => boolean): string[] | null => {
  const out: string[] = [];
  const visit = (d: Dir, rel: string, left: number): void => {
    for (const f of readdirSync(d.self, { withFileTypes: true })) {
      if (f.isFile() && keep(f.name)) out.push(join(rel, f.name));
      if (!f.isDirectory() || left === 0) continue;
      let child: Dir;
      // Swapped for a link since the listing: skip it, not the whole tree.
      try { child = step(d, f.name, false, join(abs, rel, f.name)); } catch (e) { if (absent(e)) continue; throw e; }
      try { visit(child, join(rel, f.name), left - 1); } finally { child.close(); }
    }
  };
  try {
    within(root, abs, false, (d) => visit(d, '', depth));
  } catch (e) {
    if (absent(e)) return null;
    throw e;
  }
  return out;
};

/** Rename below `root`, both ends reached without following a link. */
export const renameWithin = (root: string, from: string, to: string): void =>
  within(root, dirname(from), false, (a) =>
    within(root, dirname(to), true, (b) => renameSync(a.at(basename(from)), b.at(basename(to)))));
