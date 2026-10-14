// lib/log.mjs — console output that also reads well in GitHub Actions (::warning:: / ::error:: annotations).

export class XpdError extends Error {
  /** @param {string} message @param {number} [code] process exit code */
  constructor(message, code = 1) {
    super(message);
    this.name = 'XpdError';
    this.code = code;
  }
}

const inActions = () => Boolean(process.env.GITHUB_ACTIONS);

export const log = (...a) => console.log(...a);
export const warn = (m) => console.warn(inActions() ? `::warning::${m}` : `! ${m}`);
export const errorLine = (m) => console.error(inActions() ? `::error::${m}` : `x ${m}`);

/** Throws an XpdError (the CLI turns it into a message + exit code). */
export const fail = (m, code = 1) => {
  throw new XpdError(m, code);
};
