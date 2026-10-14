#!/usr/bin/env node
// test/fakes/ssh.mjs — a stand-in for ssh: runs the remote command with the local sh, HOME = $FAKE_SSH_HOME.
// Records its arguments in $FAKE_SSH_LOG (one JSON line per call). FAKE_SSH_FAIL_TIMES=N: the first N calls exit 255
// (a refused connection), counted in $FAKE_SSH_LOG.count.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const cmd = args[args.length - 1];
const log = process.env.FAKE_SSH_LOG;
if (log) appendFileSync(log, `${JSON.stringify(args)}\n`);
const failTimes = Number(process.env.FAKE_SSH_FAIL_TIMES || 0);
if (failTimes && log) {
  const f = `${log}.count`;
  const n = existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0;
  writeFileSync(f, String(n + 1));
  if (n < failTimes) {
    console.error('ssh: connect to host example port 10022: Connection refused');
    process.exit(255);
  }
}
const child = spawn(process.env.FAKE_SSH_SH || 'sh', ['-c', cmd], {
  stdio: ['pipe', 'inherit', 'inherit'],
  env: { ...process.env, HOME: process.env.FAKE_SSH_HOME },
});
process.stdin.pipe(child.stdin);
child.on('close', (code) => process.exit(code ?? 1));
