import BuildCopy from '../../landing/BuildCopy'
import { useState } from 'react'
import { ArrowUpRight, Search } from 'lucide-react'
import type { GenerativeUi } from './generativeUi'
type Work = { id: string; title: string; createdAt: number; messages: { role: string; content: string; generativeUi?: GenerativeUi; doc?: unknown; sheet?: unknown; deck?: unknown; design?: unknown; cad?: unknown; video?: unknown }[] }
export default function GenerativeLibrary({ chats, onOpen, onNew }: { chats: Work[]; onOpen: (id: string) => void; onNew: () => void }) {
  const [query, setQuery] = useState('')
  const filtered = chats.filter(chat => chat.title.toLowerCase().includes(query.toLowerCase()))
  return <section className="generative-library" aria-label="Saved workspaces"><header><div><span className="generative-eyebrow">A PLACE FOR EVERY THOUGHT</span><h1><BuildCopy text="Your work, right here."/></h1><p>Conversations, creations, and the workspaces you’ve made with Nalu.</p></div><button onClick={onNew}>Start something new <ArrowUpRight size={16}/></button></header>
    <label className="generative-library-search"><Search size={16}/><input aria-label="Search saved work" placeholder="Find a thought, a project, a creation…" value={query} onChange={e => setQuery(e.target.value)}/><span>{filtered.length} saved</span></label>
    <div className="generative-library-grid">{filtered.map(chat => {
      const latest = chat.messages.slice().reverse().find(m => m.generativeUi || m.role === 'assistant')
      const kinds = new Set(chat.messages.flatMap(m => [m.doc && 'Document', m.sheet && 'Spreadsheet', m.deck && 'Presentation', m.design && 'Design', m.cad && '3D', m.video && 'Video', m.generativeUi && 'Interactive workspace'].filter(Boolean)))
      return <button className="generative-library-card" key={chat.id} onClick={() => onOpen(chat.id)}><div><time>{new Date(chat.createdAt).toLocaleDateString(undefined,{ month:'short', day:'numeric' })}</time><ArrowUpRight size={16}/></div><h2><BuildCopy text={latest?.generativeUi?.title || chat.title}/></h2><p>{latest?.generativeUi?.description || latest?.content.replace(/```[\s\S]*?```/g,'').slice(0,140) || 'Pick up where you left off.'}</p><footer>{[...kinds].join(' · ') || `${chat.messages.length} messages`}</footer></button>
    })}</div>{!filtered.length && <p className="generative-library-empty">{query ? 'No saved work matches that search.' : 'Your first thought is a good place to begin.'}</p>}
  </section>
}
