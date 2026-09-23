import { writeFileSync, renameSync, unlinkSync, chmodSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Write a whole file so a concurrent reader can never catch it half-written.
 *
 * `writeFileSync` truncates the target in place, so a reader racing the write
 * can read a partial file. For the JSON this repo stores that way — a company's
 * `config.json`, a secrets vault — a partial read is a parse failure, and the
 * readers fall back to nothing: `readConfigFile` returns null (so `resolveConfig`
 * serves defaults and a company's `services` vanish for that request, a spurious
 * proxy 404), and a torn vault fails to decrypt. The keyproxy reads both fresh on
 * every request while the API writes them, so the window is live, not theoretical.
 *
 * `rename` is atomic on a single filesystem: a reader sees the whole old file or
 * the whole new one, never a torn one. The temp is created in the SAME directory
 * as the target so the rename never crosses a filesystem (which would fall back
 * to a non-atomic copy) — unless `stageIn` names another directory on the same
 * filesystem, for a target whose own directory someone else can write (see
 * `writeConfigFile`); across filesystems the rename fails with EXDEV rather
 * than copying. `mode`, when given, is forced with chmod before the
 * rename so the file is never briefly readable at wider-than-intended perms —
 * mkdir/writeFile honour a mode only masked by the umask.
 */
export const atomicWriteFileSync = (
  path: string, contents: string, mode?: number, stageIn = dirname(path),
): void => {
  const tmp = `${join(stageIn, basename(path))}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    // Create the temp at the target mode from the start, so vault ciphertext or
    // a raw key is never briefly readable at a wider (umask-default) mode; the
    // chmod after still forces it exact in case a permissive umask widened it.
    writeFileSync(tmp, contents, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (e) {
    // The temp may not exist (the write itself failed); removing it is best
    // effort, and the original file is untouched either way.
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw e;
  }
};
