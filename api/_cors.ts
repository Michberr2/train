// CORS for the Nalu Desktop app (and any cross-origin client). Auth is a Bearer
// token in the Authorization header (NOT cookies), so a wildcard origin is safe
// and correct — no credentialed-CORS needed. Returns true if the request was a
// preflight that has already been answered (handler should return immediately).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function cors(req: any, res: any): boolean {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Max-Age', '86400')
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return true
  }
  return false
}
