const esc=(v:unknown):string=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
/** A readable, self-contained companion to the original editable source data. */
function render(value:any):string {
  if(value==null)return ''
  if(typeof value!=='object')return `<p>${esc(value)}</p>`
  if(Array.isArray(value))return value.map(render).join('')
  if(value.type==='table'||(Array.isArray(value.columns)&&Array.isArray(value.rows)))return `<div class="table"><table><thead><tr>${(value.columns||[]).map((c:any)=>`<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${(value.rows||[]).map((r:any)=>`<tr>${(Array.isArray(r)?r:Object.values(r||{})).map((v:any)=>`<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
  if(value.type==='heading')return `<h2>${esc(value.text)}</h2>`
  if(value.type==='paragraph')return `<p>${esc(value.text)}</p>`
  if(value.type==='bullets')return `<ul>${(value.items||[]).map((i:any)=>`<li>${esc(i)}</li>`).join('')}</ul>`
  if(value.type==='image'&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value.src||''))return `<figure><img src="${value.src}"><figcaption>${esc(value.caption)}</figcaption></figure>`
  return Object.entries(value).filter(([k])=>!['design','mediaPreference','cover','type','kind'].includes(k)).map(([k,v])=>`<section>${['title','name','headline'].includes(k)?`<h2>${esc(v)}</h2>`:['text','body','content'].includes(k)?render(v):`<h3>${esc(k.replace(/([A-Z])/g,' $1'))}</h3>${render(v)}`}</section>`).join('')
}
export function attachmentPreview(title:string,data:unknown) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${esc(title)}</title><style>body{max-width:900px;margin:0 auto;padding:24px;color:#242424;background:#fff;font:17px/1.6 -apple-system,BlinkMacSystemFont,sans-serif}h1,h2{line-height:1.2;letter-spacing:-.025em}h1{font-size:32px}h2{font-size:24px;margin-top:28px}h3{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:#776347;margin-top:24px}p{white-space:pre-wrap;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;font-size:14px}.table{overflow:auto}td,th{padding:10px;text-align:left;border-bottom:1px solid #ddd}th{background:#f6f2eb}img{max-width:100%}section{break-inside:avoid}figcaption{font-size:14px;color:#777}</style></head><body><h1>${esc(title)}</h1>${render(data)}</body></html>`
}
