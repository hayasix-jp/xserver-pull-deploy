// test/github-reporter.mjs — node --test reporter that turns each failing test into a GitHub Actions error annotation,
// so failures are readable on the run page without signing in. Used by test/run.mjs only when GITHUB_ACTIONS is set.
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

export default async function* githubReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:fail') continue;
    const { name, file, line, details } = event.data;
    if (details?.error?.failureType === 'subtestsFailed') continue;   // the failing subtest is reported itself
    const err = details?.error?.cause ?? details?.error;
    const msg = [err?.message ?? String(err), err?.stack?.split('\n').slice(1, 4).join('\n')].filter(Boolean).join('\n');
    const path = file ? relative(process.cwd(), file.startsWith('file:') ? fileURLToPath(file) : file).replace(/\\/g, '/') : '';
    const where = path ? `file=${escProp(path)}${line ? `,line=${line}` : ''},` : '';
    yield `::error ${where}title=${escProp(name)}::${esc(msg.slice(0, 3000))}\n`;
  }
}
