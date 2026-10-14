// lib/prompt.mjs — terminal questions. `secret` = no echo when the terminal allows it.
import { createInterface } from 'node:readline';

export async function ask(question, { secret = false } = {}) {
  const stdin = process.stdin;
  if (secret && stdin.isTTY && typeof stdin.setRawMode === 'function') {
    process.stdout.write(question);
    return new Promise((res) => {
      let buf = '';
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      const onData = (s) => {
        for (const ch of s) {
          if (ch === '\r' || ch === '\n') {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.off('data', onData);
            process.stdout.write('\n');
            return res(buf.trim());
          }
          if (ch === '\u0003') {
            process.stdout.write('\n');
            process.exit(130);
          }
          if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
          else buf += ch;
        }
      };
      stdin.on('data', onData);
    });
  }
  if (secret) console.log('（この端末では入力が画面に表示されます。入力後に画面を消してください）');
  const rl = createInterface({ input: stdin, output: process.stdout });
  const answer = await new Promise((res) => rl.question(question, res));
  rl.close();
  return answer.trim();
}
