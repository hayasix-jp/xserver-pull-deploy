// lib/ssh.mjs — one ssh process per operation. Uses the system ssh (Git for Windows / Windows OpenSSH / macOS / Linux).
import { spawn } from 'node:child_process';
import { warn } from './log.mjs';

export const sshArgs = (c) => [
  '-p', c.port,
  '-i', c.key,
  '-o', 'IdentitiesOnly=yes',
  '-o', 'BatchMode=yes',
  '-o', `StrictHostKeyChecking=${c.strict}`,
  ...(c.knownHosts ? ['-o', `UserKnownHostsFile=${c.knownHosts}`] : []),
  '-o', 'ConnectTimeout=20',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=4',
  `${c.user}@${c.host}`,
];

/** [command, args] — a .mjs/.js "ssh" (the test suite's stand-in) runs under this Node. */
const sshCommand = (c, remoteCmd) =>
  /\.(m?js)$/.test(c.sshBin) ? [process.execPath, [c.sshBin, ...sshArgs(c), remoteCmd]] : [c.sshBin, [...sshArgs(c), remoteCmd]];

/** Printable form for --dry-run */
export const sshPreview = (c, remoteCmd) => `${c.sshBin} ${sshArgs(c).join(' ')} '${remoteCmd}'`;

/**
 * Runs remoteCmd on the server (stdin = input buffer or nothing). Retries only connection failures (exit 255),
 * waiting 5 s, 10 s, … (`retryDelayMs` for tests).
 * @returns {Promise<number>} exit code
 */
export const ssh = async (c, remoteCmd, input, { retryDelayMs = 5000 } = {}) => {
  for (let attempt = 1; ; attempt++) {
    const [cmd, args] = sshCommand(c, remoteCmd);
    const code = await new Promise((res) => {
      const child = spawn(cmd, args, { stdio: [input ? 'pipe' : 'ignore', 'inherit', 'inherit'] });
      child.on('error', (e) => {
        console.error(`ssh を起動できません（${e.message}）。XPD_SSH_BIN を確認してください。`);
        res(127);
      });
      child.on('close', (code_) => res(code_ ?? 1));
      if (input) {
        child.stdin.on('error', () => {}); // EPIPE when the connection drops; the exit code tells the story
        child.stdin.end(input);
      }
    });
    if (code !== 255 || attempt > c.retries) return code;
    const wait = retryDelayMs * attempt;
    warn(`SSH 接続に失敗（exit 255）。${wait / 1000} 秒後に再試行します（${attempt}/${c.retries}）`);
    await new Promise((r) => setTimeout(r, wait));
  }
};
