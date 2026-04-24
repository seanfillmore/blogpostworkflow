// agents/dashboard/lib/auth.js
export function createAuthCheck(envMap) {
  const tokens = [];
  const addToken = (user, pass) => {
    if (user && pass) {
      tokens.push('Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'));
    }
  };
  addToken(envMap.DASHBOARD_USER, envMap.DASHBOARD_PASSWORD);
  addToken(envMap.REVIEWER_USER, envMap.REVIEWER_PASSWORD);

  const AUTH_REQUIRED = tokens.length > 0;

  return function checkAuth(req, res) {
    if (!AUTH_REQUIRED) return true;
    if (tokens.includes(req.headers['authorization'])) return true;
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="SEO Dashboard"', 'Content-Type': 'text/plain' });
    res.end('Unauthorized');
    return false;
  };
}
