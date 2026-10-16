import { createHash } from 'node:crypto'

const extensions:Record<string,string> = {
  'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif',
  'image/svg+xml':'svg','image/avif':'avif','video/mp4':'mp4','video/webm':'webm',
  'video/quicktime':'mov','audio/mpeg':'mp3','audio/mp4':'m4a','audio/wav':'wav',
}
const MAX_BYTES=100*1024*1024
type Media = { bytes:Buffer;mime:string;filename:string;title:string;sha256:string }

/** Recover original embedded media bytes without fetching arbitrary chat URLs. */
export function embeddedMedia(message:any):Media[] {
  const values:string[]=[]
  if(typeof message?.content==='string') {
    const matches=message.content.matchAll(/!\[[^\]]*\]\((data:[^\s)]+)\)/g)
    for(const match of matches)values.push(match[1])
  }
  for(const value of [message?.video,message?.image]) {
    if(typeof value==='string')values.push(value)
    else if(typeof value?.url==='string')values.push(value.url)
  }
  const files:Media[]=[],seen=new Set<string>()
  for(const value of values) {
    const comma=value.indexOf(',');if(comma<0||comma>100)continue
    const head=/^data:([^;,]+);base64$/i.exec(value.slice(0,comma));if(!head)continue
    const mime=head[1].toLowerCase(),ext=extensions[mime];if(!ext)continue
    const encoded=value.slice(comma+1)
    if(!encoded.length||encoded.length>Math.ceil(MAX_BYTES/3)*4||encoded.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))continue
    const bytes=Buffer.from(encoded,'base64')
    if(bytes.length>MAX_BYTES||bytes.toString('base64')!==encoded)continue
    const sha256=createHash('sha256').update(bytes).digest('hex');if(seen.has(sha256))continue
    seen.add(sha256)
    const title=`${mime.startsWith('image/')?'Image':mime.startsWith('video/')?'Video':'Audio'} ${files.length+1}`
    files.push({bytes,mime,title,filename:`${title}.${ext}`,sha256})
  }
  return files
}

/** An editable draft, never a send operation. Encode UTF-8 bodies for Mail/Outlook. */
export function emailDraft(value:any):{title:string;bytes:Buffer}|null {
  if(!value||typeof value!=='object'||typeof value.body!=='string')return null
  const title=String(value.subject||'Email draft').replace(/[\r\n]+/g,' ').slice(0,300)
  const to=String(value.to||'').replace(/[\r\n]+/g,' ')
  const subject='=?UTF-8?B?'+Buffer.from(title).toString('base64')+'?='
  const body=Buffer.from(value.body).toString('base64').match(/.{1,76}/g)?.join('\r\n')||''
  return {title,bytes:Buffer.from([`To: ${to}`,`Subject: ${subject}`,'MIME-Version: 1.0','X-Unsent: 1','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',body,''].join('\r\n'))}
}
