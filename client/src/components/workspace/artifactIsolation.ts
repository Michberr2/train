import { artifactViewerHtml, ARTIFACT_SANDBOX, artifactDocument } from '../../../../shared/artifactIsolation'
export { ARTIFACT_SANDBOX, artifactDocument }

const releaseLater = (url: string) => setTimeout(() => URL.revokeObjectURL(url), 60000)

export function openArtifactHtml(html: string, title = 'Nalu artifact'): void {
  const url = URL.createObjectURL(new Blob([artifactViewerHtml(html, title)], { type: 'text/html' }))
  window.open(url, '_blank', 'noopener,noreferrer')
  releaseLater(url)
}

/** Files with active document MIME types must never be opened as account-origin
 * blobs. Rendering an existing HTML/SVG attachment in a sandbox also preserves
 * its scripting and internal navigation without giving it account access. */
export function openArtifactBlob(blob: Blob, title = 'Nalu attachment'): void {
  const type = blob.type.split(';')[0].trim().toLowerCase()
  // Explicit inert formats can use the browser's native image/PDF/text viewer.
  // Unknown MIME types go through the sandbox because content sniffing may turn
  // an uploaded file into an active document.
  const activeExtension = /\.(?:html?|xhtml|svgz?|xml|xsl|mhtml?)$/i.test(title)
  const inert = !activeExtension && /^(?:image\/(?:png|jpeg|gif|webp|avif|bmp)|application\/pdf|text\/plain|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/.test(type)
  const htmlDocument = /^(?:text\/html|application\/xhtml\+xml)$/.test(type) || /\.x?html?$/i.test(title)
  const source = URL.createObjectURL(blob)
  if (inert) {
    window.open(source, '_blank', 'noopener,noreferrer')
    releaseLater(source)
    return
  }
  const viewer = document.createElement('iframe')
  viewer.setAttribute('sandbox', ARTIFACT_SANDBOX)
  viewer.setAttribute('referrerpolicy', 'no-referrer')
  viewer.setAttribute('title', title)
  if (!htmlDocument) viewer.setAttribute('src', source)
  viewer.style.cssText = 'border:0;width:100%;height:100%;display:block'
  // An opaque blob document cannot reliably change its own fragment URL. The
  // trusted viewer reads HTML as text and assigns only iframe.srcdoc, preserving
  // srcdoc's in-document hash behavior. Opening remains synchronous with the
  // user gesture; no supplied HTML is ever inserted in the outer document.
  const literal = (value: string) => JSON.stringify(value).replace(/</g, '\\u003c')
  const loader = htmlDocument ? `<script>fetch(${literal(source)}).then(function(r){return r.text()}).then(function(html){var helpers=${literal(artifactDocument(''))};document.querySelector('iframe').srcdoc=/<head[^>]*>/i.test(html)?html.replace(/<head[^>]*>/i,function(m){return m+helpers}):helpers+html}).catch(function(){document.body.textContent='This attachment could not be opened. Download the original file instead.'})</script>` : ''
  const doc = '<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}</style></head><body>' + viewer.outerHTML + loader + '</body></html>'
  const url = URL.createObjectURL(new Blob([doc], { type: 'text/html' }))
  window.open(url, '_blank', 'noopener,noreferrer')
  releaseLater(url)
  releaseLater(source)
}
