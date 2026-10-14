#!/usr/bin/env node
// test/fakes/rsync.mjs — a stand-in for rsync, used ONLY by the test suite when the machine has no real rsync
// (Git for Windows). It implements exactly the subset server/remote-deploy.sh uses:
//   -a -n -i -c --no-times --delete --delete-delay --delay-updates --chmod=D755,F644
//   --exclude=PAT --exclude-from=FILE --filter=". FILE" (merge file with "P /path" and "- pat" rules)  SRC/ DST/
// Itemized output: "*deleting   path", ">f+++++++++ path", ">fc........ path", "cd+++++++++ path/".
// FAKE_RSYNC_FAIL=1 makes a real (non dry-run) transfer fail with exit 23 before changing anything.
// On a machine with a real rsync the suite uses that instead (see test/helpers/env.mjs).
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { matches } from '../../lib/pattern.mjs';

/** /c/x → c:/x; any other POSIX path of Git for Windows (/tmp/… is a mount of %TEMP%) through cygpath */
const native = (p) => {
  if (process.platform !== 'win32' || !p.startsWith('/')) return p;
  if (/^\/[A-Za-z]\//.test(p)) return `${p[1]}:${p.slice(2)}`;
  const r = spawnSync('cygpath', ['-w', p], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : p;
};

const args = process.argv.slice(2);
let dry = false;
let itemize = false;
let del = false;
let chmod = '';
const rules = []; // {type: 'exclude'|'protect', pattern}
const pos = [];

const readRules = (file, defaultType) => {
  for (const raw of readFileSync(native(file), 'utf8').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line || line.startsWith('#')) continue;
    if (defaultType === 'exclude') rules.push({ type: 'exclude', pattern: line });
    else if (line.startsWith('P ')) rules.push({ type: 'protect', pattern: line.slice(2) });
    else if (line.startsWith('- ')) rules.push({ type: 'exclude', pattern: line.slice(2) });
    else throw new Error(`fake rsync: unsupported filter line: ${line}`);
  }
};

for (const a of args) {
  if (a === '--dry-run') dry = true;
  else if (a === '--itemize-changes') itemize = true;
  else if (a === '--delete' || a === '--delete-delay') del = true;
  else if (a === '--delay-updates' || a === '--no-times' || a === '--checksum') { /* no-op here */ }
  else if (a.startsWith('--chmod=')) chmod = a.slice(8);
  else if (a.startsWith('--exclude=')) rules.push({ type: 'exclude', pattern: a.slice(10) });
  else if (a.startsWith('--exclude-from=')) readRules(a.slice(15), 'exclude');
  else if (a.startsWith('--filter=')) {
    const f = a.slice(9);
    if (!f.startsWith('. ')) throw new Error(`fake rsync: unsupported filter: ${f}`);
    readRules(f.slice(2), 'merge');
  } else if (/^-[a-zA-Z]+$/.test(a)) {
    for (const ch of a.slice(1)) {
      if (ch === 'n') dry = true;
      else if (ch === 'i') itemize = true;
    }
  } else if (a.startsWith('-')) throw new Error(`fake rsync: unsupported option ${a}`);
  else pos.push(a);
}
if (pos.length !== 2) {
  console.error('fake rsync: need SRC/ DST/');
  process.exit(1);
}
const src = native(pos[0]).replace(/\/+$/, '');
const dst = native(pos[1]).replace(/\/+$/, '');

const ruleFor = (rel, isDir) => rules.find((r) => matches(r.pattern, rel, isDir));
const excluded = (rel, isDir) => ruleFor(rel, isDir)?.type === 'exclude';
const isDirAt = (p) => existsSync(p) && lstatSync(p).isDirectory();

const out = [];
const actions = [];

// transfers (sender side)
const scanSrc = (rel) => {
  for (const name of readdirSync(join(src, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    const s = join(src, r);
    const d = join(dst, r);
    const dir = isDirAt(s);
    if (excluded(r, dir)) continue;
    if (dir) {
      if (!isDirAt(d)) {
        out.push(`cd+++++++++ ${r}/`);
        actions.push(() => {
          if (existsSync(d)) rmSync(d, { recursive: true, force: true });
          mkdirSync(d, { recursive: true });
        });
      }
      scanSrc(r);
    } else {
      const exists = existsSync(d) && !isDirAt(d);
      if (!exists) {
        out.push(`>f+++++++++ ${r}`);
        actions.push(() => {
          if (existsSync(d)) rmSync(d, { recursive: true, force: true });
          copyFileSync(s, d);
        });
      } else if (!readFileSync(s).equals(readFileSync(d))) {
        out.push(`>fc........ ${r}`);
        actions.push(() => copyFileSync(s, d));
      }
    }
  }
};

// deletions (receiver side): entries not on the sender, not excluded; protected ones stay
const dels = [];
const scanDst = (rel) => {
  const dir = join(dst, rel);
  if (!isDirAt(dir)) return;
  for (const name of readdirSync(dir).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    const d = join(dst, r);
    const isDir = isDirAt(d);
    const rule = ruleFor(r, isDir);
    if (rule?.type === 'exclude') continue;
    const onSender = existsSync(join(src, r)) && isDirAt(join(src, r)) === isDir;
    if (onSender) {
      if (isDir) scanDst(r);
      continue;
    }
    if (rule?.type === 'protect') continue;
    // an extraneous dir: its contents are listed (and deleted) first, then the dir
    if (isDir) {
      const before = dels.length;
      const walk = (rr) => {
        for (const n of readdirSync(join(dst, rr)).sort()) {
          const x = `${rr}/${n}`;
          const xd = isDirAt(join(dst, x));
          const xr = ruleFor(x, xd);
          if (xr) continue; // excluded or protected below an extraneous dir: kept
          if (xd) walk(x);
          dels.push({ rel: x, isDir: xd });
        }
      };
      walk(r);
      void before;
    }
    dels.push({ rel: r, isDir });
  }
};

scanSrc('');
if (del) scanDst('');
for (const x of dels) out.push(`*deleting   ${x.rel}${x.isDir ? '/' : ''}`);

if (!dry) {
  if (process.env.FAKE_RSYNC_FAIL === '1') {
    console.error('rsync: simulated failure');
    process.exit(23);
  }
  for (const a of actions) a();
  for (const x of dels) {
    const p = join(dst, x.rel);
    if (x.isDir) {
      try {
        rmdirSync(p);
      } catch {
        /* not empty: something below it is protected */
      }
    } else rmSync(p, { force: true });
  }
  if (chmod) {
    const [dm, fm] = chmod.split(',').map((s) => Number.parseInt(s.slice(1), 8));
    const walk = (rel) => {
      for (const n of readdirSync(join(dst, rel))) {
        const r = rel ? `${rel}/${n}` : n;
        if (excluded(r, isDirAt(join(dst, r)))) continue;
        const p = join(dst, r);
        if (isDirAt(p)) {
          chmodSync(p, dm);
          walk(r);
        } else if (existsSync(join(src, r))) chmodSync(p, fm);
      }
    };
    walk('');
  }
}
if (itemize) process.stdout.write(out.length ? `${out.join('\n')}\n` : '');
