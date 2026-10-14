// test/helpers/fake-github.mjs — the parts of the GitHub REST API that pull.sh uses, on 127.0.0.1.
//
//   GET /repos/:owner/:repo/commits/:ref        Accept: application/vnd.github.sha → 40-hex text, ETag, 304
//                                               missing branch → 422 (GitHub's real answer) or 404 (missingStatus)
//   GET /repos/:owner/:repo/contents/:path?ref= Accept: application/vnd.github.raw+json → the raw file
// Every request must carry "Authorization: Bearer <token>" (else 401). Responses carry
// github-authentication-token-expiration and x-ratelimit-remaining.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

export const randomSha = () => randomBytes(20).toString('hex');

export async function startFakeGitHub({ repo = 'your-org/your-site', token = 'github_pat_TEST0000000000000000000000' } = {}) {
  const state = {
    repo,
    token,
    branches: {}, // name → {sha, files: {path: Buffer}}
    missingStatus: 422,
    override: null, // (req, url) => {status, headers?, body?} | undefined
    tokenExpiration: '2030-01-01 00:00:00 UTC',
    rateRemaining: '4999',
    requests: [],
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    state.requests.push({ method: req.method, path: url.pathname, search: url.search, inm: req.headers['if-none-match'] || '' });
    const send = (status, body = '', headers = {}) => {
      res.writeHead(status, {
        'github-authentication-token-expiration': state.tokenExpiration,
        'x-ratelimit-remaining': state.rateRemaining,
        ...headers,
      });
      res.end(body);
    };
    const o = state.override?.(req, url);
    if (o) return send(o.status, o.body ?? '', o.headers ?? {});
    if (req.headers.authorization !== `Bearer ${state.token}`) return send(401, '{"message":"Bad credentials"}');
    const m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/(commits|contents)\/(.+)$/);
    if (!m || m[1] !== state.repo) return send(404, '{"message":"Not Found"}');
    if (m[2] === 'commits') {
      const b = state.branches[decodeURIComponent(m[3])];
      if (!b) return send(state.missingStatus, '{"message":"No commit found for SHA"}');
      const etag = `"${b.sha}"`;
      if (req.headers['if-none-match'] === etag) return send(304, '', { etag });
      return send(200, b.sha, { etag, 'content-type': 'application/vnd.github.sha' });
    }
    const ref = url.searchParams.get('ref');
    const b = Object.values(state.branches).find((x) => x.sha === ref);
    const f = b?.files[decodeURIComponent(m[3])];
    if (!f) return send(404, '{"message":"Not Found"}');
    return send(200, f, { 'content-type': 'application/octet-stream' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    state,
    url: `http://127.0.0.1:${port}`,
    setBranch(name, files = {}, sha = randomSha()) {
      state.branches[name] = { sha, files };
      return sha;
    },
    deleteBranch(name) {
      delete state.branches[name];
    },
    count: (re) => state.requests.filter((r) => re.test(r.path)).length,
    close: () => new Promise((r) => server.close(r)),
  };
}
