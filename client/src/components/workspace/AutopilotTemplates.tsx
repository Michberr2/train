import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Layers, Search, X } from 'lucide-react'

export type PipelineTemplateCard = { key: string; name: string; description: string; output: string }

export default function AutopilotTemplates({ templates, onUse, onClose, onCompany }: {
  templates: PipelineTemplateCard[]; onUse: (key: string) => void; onClose: () => void; onCompany: () => void
}) {
  const [search, setSearch] = useState('')
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.querySelector('input')?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  const visible = templates.filter(t => `${t.name} ${t.description} ${t.output}`.toLowerCase().includes(search.toLowerCase().trim()))
  return <div className="ap-template-backdrop" onClick={onClose}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label="Prebuilt pipelines" className="ap-template-dialog bg-panel2" onClick={e => e.stopPropagation()} onKeyDown={e => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      if (e.key !== 'Tab') return
      const targets = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('input,button:not(:disabled)')).filter(el => el.offsetParent !== null)
      const first = targets[0], last = targets[targets.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
    }}>
      <header><div><span><Layers size={18} />Template library</span><h2>Prebuilt pipelines</h2></div><button aria-label="Close templates" onClick={onClose}><X size={20} /></button></header>
      <p>Start with a connected pipeline. Add your context, review the steps, and press Run. Each template creates a new copy in your pipelines.</p>
      <label className="ap-template-search"><Search size={17} /><input aria-label="Search templates" placeholder="Find a pipeline…" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <div className="ap-template-grid">{visible.map(t => <article key={t.key}><h3>{t.name}</h3><p>{t.description}</p><span>{t.output}</span><button aria-label={`Use ${t.name}`} onClick={() => onUse(t.key)}>Use pipeline<ArrowRight size={16} /></button></article>)}</div>
      {!visible.length && <p>No matching templates. Try a different search.</p>}
      <footer><p>Sending and publishing require a connection you choose in the output step.</p><button onClick={onCompany}>Set up a full company team</button></footer>
    </div>
  </div>
}
