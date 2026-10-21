// test/run.mjs — runs every test/**/*.test.mjs with node --test (Node 20 has no glob support for --test).
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2);
const files = [];
const walk = (d) => {
  for (const n of readdirSync(d).sort()) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (n.endsWith('.test.mjs')) files.push(p);
  }
};
walk(here);
const pick = only.length ? files.filter((f) => only.some((o) => relative(here, f).replace(/\\/g, '/').includes(o))) : files;
// On GitHub Actions, also report each failure as an error annotation (readable on the run page without signing in).
const reporters = process.env.GITHUB_ACTIONS
  ? ['--test-reporter=spec', '--test-reporter-destination=stdout',
    `--test-reporter=${new URL('./github-reporter.mjs', import.meta.url).href}`, '--test-reporter-destination=stdout']
  : [];
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...reporters, ...pick], { stdio: 'inherit' });
process.exit(r.status ?? 1);
