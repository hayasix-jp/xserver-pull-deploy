// lib/pattern.mjs — the small subset of rsync's include/exclude pattern syntax that "protect" entries use.
//
//   /uploads/        a directory at the top of the site (and everything under it)
//   /google*.html    a file at the top whose name matches (* and ? never match "/")
//   *.bak            no leading "/": matched against the last path component at any depth
//
// The server (rsync --exclude-from) interprets the same lines; this copy is used on the PC to validate the list
// and to leave protected paths out of a bundle, and by the test suite's rsync stand-in.

/** A protect entry the server accepts: absolute or basename pattern, safe characters only, no "..". */
export const PROTECT_RE = /^\/?[A-Za-z0-9._*?/-]+$/;

export const validProtect = (p) =>
  typeof p === 'string' && PROTECT_RE.test(p) && !p.split('/').includes('..') && p !== '/' && !p.includes('//') && p.length <= 200;

const escapeRe = (s) => s.replace(/[.*?+^${}()|[\]\\]/g, '\\$&');

/** glob → RegExp for one pattern body (no anchoring slash, no trailing slash). Supports backslash escapes. */
const globToRe = (glob) => {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '\\' && i + 1 < glob.length) re += escapeRe(glob[++i]);
    else if (c === '*') re += glob[i + 1] === '*' ? (i++, '.*') : '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`);
};

/**
 * Does `pattern` match the relative path `rel` ("a/b/c.html", no leading slash)?
 * `isDir` tells whether rel itself is a directory. A directory match also covers everything below it
 * (use `matchesSelfOrParent` for that).
 */
export const matches = (pattern, rel, isDir) => {
  let p = pattern;
  const dirOnly = p.endsWith('/') && !p.endsWith('\\/');
  if (dirOnly) p = p.slice(0, -1);
  if (dirOnly && !isDir) return false;
  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  const re = globToRe(p);
  if (anchored) return re.test(rel);
  if (p.includes('/')) {
    // unanchored with a slash: matches the tail of the path at a component boundary
    const parts = rel.split('/');
    for (let i = 0; i < parts.length; i++) if (re.test(parts.slice(i).join('/'))) return true;
    return false;
  }
  return re.test(rel.split('/').pop());
};

/** True when rel or one of its parent directories matches the pattern. */
export const matchesSelfOrParent = (pattern, rel, isDir) => {
  if (matches(pattern, rel, isDir)) return true;
  const parts = rel.split('/');
  for (let i = parts.length - 1; i > 0; i--) if (matches(pattern, parts.slice(0, i).join('/'), true)) return true;
  return false;
};

/** Paths every deploy leaves alone, whatever the configuration says. */
export const BUILTIN_PROTECT = Object.freeze(['/.well-known/', '/_deploy/']);
