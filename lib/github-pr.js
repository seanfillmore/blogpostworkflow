/**
 * The two GitHub REST calls the recap reviewer needs to ship a fix: open a pull
 * request against main, and merge it with a real merge commit (so a revert is
 * one `git revert -m 1 <sha>`). The token is only ever sent in the
 * Authorization header and is never placed in an error message.
 */
export const REPO = 'seanfillmore/blogpostworkflow';
const API = `https://api.github.com/repos/${REPO}`;

const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
});

async function call(fetchImpl, url, init) {
  const res = await fetchImpl(url, init);
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { res, json };
}

const fail = (what, res, json) => new Error(`${what} failed: HTTP ${res.status}${json?.message ? ` ${json.message}` : ''}`);

/** @returns {Promise<{number: number, url: string}>} */
export async function createPullRequest({ token, head, title, body, fetchImpl = fetch }) {
  const { res, json } = await call(fetchImpl, `${API}/pulls`, {
    method: 'POST', headers: headers(token), body: JSON.stringify({ title, head, base: 'main', body }),
  });
  if (!res.ok || !json?.number) throw fail('create pull request', res, json);
  return { number: json.number, url: json.html_url };
}

/**
 * Merge with merge_method 'merge'. A 405/409 right after creation usually means
 * GitHub has not finished computing mergeability, so it is retried a few times.
 * @returns {Promise<{sha: string}>}
 */
export async function mergePullRequest({ token, number, fetchImpl = fetch, attempts = 4, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  for (let i = 1; ; i += 1) {
    const { res, json } = await call(fetchImpl, `${API}/pulls/${number}/merge`, {
      method: 'PUT', headers: headers(token), body: JSON.stringify({ merge_method: 'merge' }),
    });
    if (res.ok) {
      if (!json?.merged || !json?.sha) throw new Error(`merge pull request #${number}: not merged${json?.message ? ` (${json.message})` : ''}`);
      return { sha: json.sha };
    }
    if ((res.status === 405 || res.status === 409) && i < attempts) { await sleep(3000); continue; }
    throw fail(`merge pull request #${number}`, res, json);
  }
}
