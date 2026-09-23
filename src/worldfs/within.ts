import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync,
  realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, sep } from 'node:path';

const { O_RDONLY, O_WRONLY, O_CREAT, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = constants;

/** Whether a real path is the root or below it. */
export const inside = (realRoot: string, real: string): boolean =>
  real === realRoot || real.startsWith(realRoot + sep);

/** Whether anything, a dangling link included, sits at a path. */
export const lexists = (p: string): boolean => {
  try { lstatSync(p); return true; } catch { return false; }
};

/** Where an open descriptor really is, as the kernel says; null where there is no /proc. */
export type WhereIs = (fd: number) => string | null;
export const procWhereIs: WhereIs = (fd) => {
  try { return readlinkSync(`/proc/self/fd/${fd}`); } catch { return null; }
};

/**
 * The gateway runs outside every shift's view and works on names a shift
 * chose (a draft is named after its own summary), while that shift's shell
 * can plant links. A path checked a moment ago can be a link by the time it is
 * opened; before these existed, a draft written through one landed in another
 * company, and a FIFO at a journal's name held the whole gateway on a
 * synchronous open.
 *
 * So the directory is opened first and pinned: the kernel says where the
 * descriptor really is, and only if that is inside the root is the last
 * component looked up — through `/proc/self/fd/<dir>/<name>`, which resolves
 * from the pinned directory whatever its path now says, as openat would.
 * Nothing is ever created, read or removed through a directory outside the
 * root, so there is nothing to undo. The last component is opened with
 * O_NOFOLLOW and O_NONBLOCK, and used only if it is a regular file.
 *
 * Without /proc (macOS, where no shell runs) the directory's real path is
 * checked instead, and the path is used as given.
 */
const pinned = <T>(root: string, abs: string, whereIs: WhereIs, use: (at: string) => T): T => {
  const realRoot = realpathSync(root);
  const outside = () => new Error(`refusing to reach outside the world: ${abs}`);
  const dfd = openSync(dirname(abs), O_RDONLY | O_DIRECTORY);
  try {
    const where = whereIs(dfd);
    if (where === null) {
      if (!inside(realRoot, realpathSync(dirname(abs)))) throw outside();
      return use(abs);
    }
    if (!inside(realRoot, where)) throw outside();
    return use(`/proc/self/fd/${dfd}/${basename(abs)}`);
  } finally {
    closeSync(dfd);
  }
};

/** Open a regular file by a pinned path, refusing a link, a FIFO or anything else. */
const openFile = <T>(at: string, abs: string, flags: number, use: (fd: number) => T): T => {
  const fd = openSync(at, flags | O_NOFOLLOW | O_NONBLOCK, 0o644);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`refusing something that is not a file: ${abs}`);
    return use(fd);
  } finally {
    closeSync(fd);
  }
};

/** Write a whole file the gateway resolved inside `root`. */
export const writeWithin = (root: string, abs: string, data: string | Buffer, whereIs = procWhereIs): void => {
  // A racing swap can still aim this at another company, but only at empty
  // folders; the write below refuses a directory it cannot place inside.
  mkdirSync(dirname(abs), { recursive: true });
  pinned(root, abs, whereIs, (at) => openFile(at, abs, O_WRONLY | O_CREAT, (fd) => {
    ftruncateSync(fd, 0);
    writeFileSync(fd, data);
  }));
};

/** Read a file inside `root` as text; null if no regular file is there, a link included. */
export const readWithin = (root: string, abs: string, whereIs = procWhereIs): string | null => {
  try {
    return pinned(root, abs, whereIs, (at) => {
      const fd = openSync(at, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      try { return fstatSync(fd).isFile() ? readFileSync(fd, 'utf8') : null; } finally { closeSync(fd); }
    });
  } catch (e) {
    // A link at the name is not a document: throwing would let one planted
    // link fail every wake that reads memory.md, or /api/commons for the
    // whole company.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') return null;
    throw e;
  }
};

/** Open a regular file inside `root` for reading; the caller owns the descriptor. */
export const openWithin = (root: string, abs: string, whereIs = procWhereIs): number =>
  pinned(root, abs, whereIs, (at) => {
    const fd = openSync(at, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    if (fstatSync(fd).isFile()) return fd;
    closeSync(fd);
    throw new Error(`refusing something that is not a file: ${abs}`);
  });

/** Remove one file inside `root`. A link there is removed, never followed. */
export const unlinkWithin = (root: string, abs: string, whereIs = procWhereIs): void => {
  try {
    pinned(root, abs, whereIs, (at) => unlinkSync(at));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
};

/** Read a file as text, refusing a link or a FIFO at the name. */
export const readNoFollow = (abs: string): string =>
  openFile(abs, abs, O_RDONLY, (fd) => readFileSync(fd, 'utf8'));
