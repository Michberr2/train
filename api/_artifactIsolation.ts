import { ARTIFACT_SANDBOX, artifactDocument } from '../shared/artifactIsolation'

/** Response headers, rather than editable meta tags, enforce isolation even for
 * old public shares. Keep these headers on the HTML response itself. */
export function sendIsolatedArtifact(res: any, html: unknown): void {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Content-Security-Policy', `sandbox ${ARTIFACT_SANDBOX}; frame-ancestors 'none'; object-src 'none'`)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Cache-Control', 'no-store')
  res.status(200).send(artifactDocument(String(html || '')))
}
