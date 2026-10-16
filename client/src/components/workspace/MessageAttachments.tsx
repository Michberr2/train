import { useEffect, useState } from 'react'
import { FileText, Loader2 } from 'lucide-react'
import { loadChatAttachment } from './chatAttachments'
import type { Attachment } from './extractText'

function AttachmentPreview({ attachment }: { attachment: Attachment }) {
  const [source, setSource] = useState(attachment.dataUrl || '')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true
    setSource(attachment.dataUrl || ''); setError('')
    if (attachment.isImage && !attachment.dataUrl) {
      void loadChatAttachment(attachment, localStorage.getItem('nalu-token') || '').then(url => {
        if (current) { if (url) setSource(url); else setError('Image unavailable. Attach the original again.') }
      }).catch(() => { if (current) setError('Image could not load.') })
    }
    return () => { current = false }
  }, [attachment.id, attachment.dataUrl, attachment.storage?.id, attempt])
  return <figure className="w-36 overflow-hidden rounded-xl border border-glass/20 bg-panel/60 text-ink">
    {attachment.isImage ? source ? <a href={source} download={attachment.name} title={`Download ${attachment.name}`}><img src={source} alt={attachment.name} className="h-28 w-full object-contain" onError={() => { setSource(''); setError('Image could not be decoded.') }} /></a>
      : <div className="flex min-h-24 items-center justify-center p-2 text-xs">{error ? <span>{error}{attachment.storage && <button type="button" onClick={() => setAttempt(n => n + 1)} className="ml-1 underline">Retry image</button>}</span> : <Loader2 size={18} className="motion-safe:animate-spin" aria-label="Loading attached image" />}</div>
      : <FileText size={24} className="m-3" />}
    <figcaption className="truncate px-2 py-1.5 text-xs" title={attachment.name}>{attachment.name}</figcaption>
  </figure>
}

export default function MessageAttachments({ attachments }: { attachments: Attachment[] }) {
  if (!attachments.length) return null
  return <div aria-label="Attached files" className="mt-2 flex flex-wrap gap-2 whitespace-normal">{attachments.map(attachment => <AttachmentPreview key={attachment.id} attachment={attachment} />)}</div>
}
