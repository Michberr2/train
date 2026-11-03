import BuildCopy from '../../landing/BuildCopy'
import type { ReactNode } from 'react'
import { ArrowUpRight, History, Layers } from 'lucide-react'
export default function GenerativeHome({ composer, chats, onOpenChat, onSpaces }: {
  composer: ReactNode; chats: { id: string; title: string }[]; onOpenChat: (id: string) => void; onSpaces: () => void
}) {
  return <section className="generative-home" aria-label="Your generative workspace">
    <div className="generative-home-intro"><span className="generative-eyebrow"><BuildCopy text="YOUR IDEAS. TAKING SHAPE."/></span>
      <h1><BuildCopy text="A little thought."/><br/><strong><BuildCopy text="A whole new possibility."/></strong></h1>
      <p><BuildCopy text="Ask Nalu anything. Your workspace will take shape around it."/></p>
    </div>
    <div className="generative-home-input">{composer}<div className="generative-home-footnote"><span>Think. Explore. Make something.</span><button onClick={onSpaces}><Layers size={13}/> All your skills <ArrowUpRight size={13}/></button></div></div>
    {!!chats.length && <nav className="generative-recent" aria-label="Recent work"><span><History size={13}/> PICK UP A THOUGHT</span>{chats.slice(0, 3).map(chat => <button key={chat.id} onClick={() => onOpenChat(chat.id)}><BuildCopy text={chat.title}/><ArrowUpRight size={15}/></button>)}</nav>}
  </section>
}
