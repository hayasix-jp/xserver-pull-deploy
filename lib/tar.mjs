// lib/tar.mjs — a minimal POSIX ustar writer + gzip. Written here so the PC needs no tar binary (Windows' bsdtar and
// PowerShell pipes vary) and every OS produces the same bytes. Modes 755/644, uid/gid 0: the server re-applies
// --chmod=D755,F644 anyway.
import { gzipSync } from 'node:zlib';

const octal = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';

/**
 * One tar member. `type`: 'file' (default) | 'dir' | 'symlink' | 'hardlink' (the last two exist for the test suite,
 * which needs hostile bundles; the deploy code never writes them). `owner` (uname) is likewise for the tests.
 */
export const tarEntry = (name, body = Buffer.alloc(0), type = 'file', linkName = '', owner = '') => {
  const isDir = type === 'dir';
  const h = Buffer.alloc(512);
  let prefix = '';
  let n = name;
  if (Buffer.byteLength(n) > 100) {
    // ustar: split at a "/" so that name <= 100 bytes and prefix <= 155 bytes
    let i = n.indexOf('/');
    while (i >= 0 && Buffer.byteLength(n.slice(i + 1)) > 100) i = n.indexOf('/', i + 1);
    if (i < 0 || i === n.length - 1 || Buffer.byteLength(n.slice(0, i)) > 155) {
      throw new Error(`path too long for a tar archive: ${name}`);
    }
    prefix = n.slice(0, i);
    n = n.slice(i + 1);
  }
  const size = type === 'file' ? body.length : 0;
  h.write(n, 0, 100, 'utf8');
  h.write(octal(isDir ? 0o755 : 0o644, 8), 100);
  h.write(octal(0, 8), 108);
  h.write(octal(0, 8), 116);
  h.write(octal(size, 12), 124);
  h.write(octal(Math.floor(Date.now() / 1000), 12), 136);
  h.fill(' ', 148, 156);
  h.write({ file: '0', hardlink: '1', symlink: '2', dir: '5' }[type] ?? '0', 156);
  if (linkName) h.write(linkName, 157, 100, 'utf8');
  h.write('ustar\0', 257);
  h.write('00', 263);
  if (owner) h.write(owner, 265, 32, 'utf8'); // uname (tests only: hostile owner names)
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  if (!size) return [h];
  return [h, body, Buffer.alloc((512 - (size % 512)) % 512)];
};

/**
 * entries: [name, body?, type?, linkName?, owner?][] → gzip'd tar Buffer.
 * A name ending in "/" is a directory when no type is given.
 */
export const tarball = (entries) => {
  const parts = [];
  for (const [name, body, type, link, owner] of entries) {
    const t = type || (name.endsWith('/') ? 'dir' : 'file');
    parts.push(...tarEntry(name, body ?? Buffer.alloc(0), t, link, owner));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts), { level: 9 });
};
