/** Active generated documents run in an opaque origin, including their popups.
 * Never add allow-same-origin or allow-popups-to-escape-sandbox here. */
export const ARTIFACT_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals allow-downloads'

// Storage in an opaque origin throws. Give generated applications private,
// ephemeral storage instead of access to the account's persistent storage.
const STORAGE_SHIM = `<script>(function(){try{localStorage.length}catch(e){var mk=function(){var s=Object.create(null);return{getItem:function(k){return Object.prototype.hasOwnProperty.call(s,k)?s[k]:null},setItem:function(k,v){s[k]=String(v)},removeItem:function(k){delete s[k]},clear:function(){s=Object.create(null)},key:function(i){return Object.keys(s)[i]||null},get length(){return Object.keys(s).length}}};try{Object.defineProperty(window,'localStorage',{value:mk(),configurable:true});Object.defineProperty(window,'sessionStorage',{value:mk(),configurable:true})}catch(e2){}}})()</script>`

// A srcdoc fragment otherwise resolves against its parent's base URL, which can
// replace the generated application. Run after document-level page handlers and
// only handle unclaimed, ordinary fragment clicks. Keep authored base URLs and
// relative resources untouched; changing <base> would affect unrelated links.
export const ARTIFACT_FRAGMENT_NAVIGATION = `<script>window.addEventListener('click',function(event){var target=event.target;var link=target&&target.closest&&target.closest('a[href^="#"]');if(!link||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||link.hasAttribute('download')||link.target&&link.target!=='_self')return;var hash=link.getAttribute('href');if(!hash)return;event.preventDefault();if(location.hash!==hash)location.hash=hash;try{var section=hash==='#'?document.documentElement:document.getElementById(decodeURIComponent(hash.slice(1)));if(section)section.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'})}catch(e){}})</script>`

export function artifactDocument(html: string): string {
  const helpers = STORAGE_SHIM + ARTIFACT_FRAGMENT_NAVIGATION
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, match => match + helpers)
  return helpers + html
}

const attribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The outer viewer contains no generated markup: all content is an escaped
 * attribute in a sandboxed frame. This is safe even when the viewer is a blob
 * created on the account's origin. */
export function artifactViewerHtml(html: string, title = 'Nalu artifact'): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${attribute(title)}</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style></head><body><iframe title="${attribute(title)}" sandbox="${ARTIFACT_SANDBOX}" referrerpolicy="no-referrer" srcdoc="${attribute(artifactDocument(html))}"></iframe></body></html>`
}
