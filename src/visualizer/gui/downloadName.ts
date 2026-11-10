// src/visualizer/gui/downloadName.ts

/**
 * Builds a default filename for a download so repeated saves do not overwrite each other.
 *
 * The result is `<base>_<YYYYMMDD>-<HHMMSS>.<ext>` in local time, with characters that are
 * awkward in filenames replaced by `-`. Pass a model name as `base` to get a model-derived
 * name (a trailing `.stl` is dropped).
 *
 * @param base - What the file is, e.g. `"augprint-preset"` or a model name.
 * @param ext - File extension, with or without the leading dot.
 * @param now - The time to stamp the name with. Defaults to the current time.
 * @returns The filename, including the extension.
 */
export function defaultDownloadName(base: string, ext: string, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const cleanBase = base
    .trim()
    .replace(/\.stl$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'download';
  const cleanExt = ext.replace(/^\.+/, '');

  return cleanExt ? `${cleanBase}_${stamp}.${cleanExt}` : `${cleanBase}_${stamp}`;
}
