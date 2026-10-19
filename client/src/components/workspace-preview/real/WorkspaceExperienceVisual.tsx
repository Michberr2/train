import { ArrowUp, ArrowUpRight, BarChart3, Check, FileText, ListChecks, Palette, Search, Terminal } from 'lucide-react'
import NaluMark from '../../landing/NaluMark'
import { BACKGROUNDS } from '../../../lib/backgroundAssets'
import './workspace-experience-visual.css'

type ExperienceView = 'chat' | 'studio' | 'memory' | 'skills'
const beach = BACKGROUNDS['/images/bg-sandy-beach.png'].small
const coast = BACKGROUNDS['/images/bg-beach-rocks.png'].small

/** Illustrative product previews. Nothing inside these miniatures is interactive
 * or represents the person's actual conversations, creations, or enabled skills. */
export default function WorkspaceExperienceVisual({ view, active }: { view: ExperienceView; active: boolean }) {
  return <div className="workspace-experience-visual" data-experience={view} data-active={active} aria-hidden="true">
    {view === 'studio' && <div className="experience-website">
      <div className="experience-browser"><span><i/><i/><i/></span><span>cove / stay</span><small>EXAMPLE</small></div>
      <div className="experience-site-nav"><strong>cove.</strong><div><span>The stay</span><span>Our story</span><span>Visit us <ArrowUpRight size={6}/></span></div></div>
      <div className="experience-site-hero" style={{ backgroundImage: `linear-gradient(90deg,rgba(26,45,67,.67),rgba(26,45,67,.08)),url(${beach})` }}>
        <span>ROOM TO BREATHE</span><h3>A slower<br/>kind of stay.</h3><div className="experience-site-cta">Find your escape <ArrowUpRight size={7}/></div>
      </div>
      <div className="experience-site-bottom"><div><strong>A place to exhale.</strong><p>Quiet mornings. Open horizons.</p><span>Discover the coast <ArrowUpRight size={6}/></span></div><div className="experience-site-image" style={{ backgroundImage: `linear-gradient(0deg,#23456150,transparent),url(${coast})` }}><span>BY THE SEA</span></div></div>
    </div>}
    {view === 'chat' && <div className="experience-chat">
      <div className="experience-chat-heading"><span><NaluMark/>Nalu</span><small>CONVERSATION</small></div>
      <div className="experience-chat-user"><span>Help me turn this idea into a plan.</span></div>
      <div className="experience-chat-answer"><NaluMark/><div><strong>Let’s make it useful.</strong><span><i>01</i> Define the outcome.</span><span><i>02</i> Choose a first step.</span><span><i>03</i> Make room to improve.</span></div></div>
      <div className="experience-chat-composer"><span>Ask Nalu anything…</span><span className="experience-composer-plus">+</span><i><ArrowUp size={10}/></i></div>
    </div>}
    {view === 'memory' && <div className="experience-memory">
      <div className="experience-memory-search"><span>WORK IN VIEW</span><small>EXAMPLE</small></div>
      <div className="experience-memory-record"><i className="experience-work-dot"/><div><strong>Coastal launch website</strong><p>Refining the first page</p></div><span className="experience-work-state">Working</span></div>
      <div className="experience-memory-record"><i className="experience-work-dot needs-you"/><div><strong>Launch direction</strong><p>Ready for your review</p></div><span className="experience-work-state">Needs you</span></div>
    </div>}
    {view === 'skills' && <div className="experience-skills">
      <div className="experience-skills-heading"><span className="experience-mini-label">YOUR TOOLKIT</span><small>Shaped around your work.</small></div>
      <div className="experience-skills-grid">{[
        { name: 'Research', Icon: Search, chosen: true },
        { name: 'Create', Icon: Palette, chosen: true },
        { name: 'Analyze', Icon: BarChart3, chosen: false },
        { name: 'Plan', Icon: ListChecks, chosen: false },
        { name: 'Write', Icon: FileText, chosen: true },
        { name: 'Build', Icon: Terminal, chosen: false },
      ].map(({ name, Icon, chosen }) => <div key={name} className="experience-skill" data-chosen={chosen}><Icon strokeWidth={1}/><strong>{name}</strong><i>{chosen && <Check size={6}/>}</i></div>)}</div>
    </div>}
  </div>
}
