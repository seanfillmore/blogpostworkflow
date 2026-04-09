// agents/dashboard/lib/auth.js
export function createAuthCheck(envMap) {
  const AUTH_USER = envMap.DASHBOARD_USER || '';
  const AUTH_PASS = envMap.DASHBOARD_PASSWORD || '';
  const AUTH_REQUIRED = AUTH_USER && AUTH_PASS;
  const AUTH_TOKEN = AUTH_REQUIRED
    ? 'Basic ' + Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64')
    : null;

  return function checkAuth(req, res) {
    if (!AUTH_REQUIRED) return true;
    if (req.headers['authorization'] === AUTH_TOKEN) return true;
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="SEO Dashboard"', 'Content-Type': 'text/plain' });
    res.end('Unauthorized');
    return false;
  };
}
