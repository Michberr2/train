import { useState } from 'react'
import { ArrowRight, ArrowUpRight, Check, Globe, Lock } from 'lucide-react'
import './websiteStarter.css'

const DIRECTIONS = [
  { key: 'business', label: 'Business', brand: 'Northline', eyebrow: 'Thoughtful work. Lasting impact.', headline: 'Built around\nyour next chapter.', caption: 'A clear point of view. A better way forward.', cta: 'Explore what we do', style: 'minimal', brief: 'a modern independent business: introduce what we do, explain our services, show selected work, and make it easy to get in touch' },
  { key: 'portfolio', label: 'Portfolio', brand: 'Studio / 01', eyebrow: 'Independent design & creative direction', headline: 'Selected work.\nDistinct perspective.', caption: 'Ideas made tangible, one project at a time.', cta: 'View selected work', style: 'editorial', brief: 'a personal creative portfolio: a distinctive introduction, a curated project gallery, an about section, and a contact form' },
  { key: 'store', label: 'Store', brand: 'Everyday objects', eyebrow: 'Considered essentials', headline: 'Simple things.\nBeautifully made.', caption: 'Discover pieces with a place in your everyday.', cta: 'Explore the collection', style: 'organic', brief: 'a curated online store: a beautiful collection page, product details, category filters, and a working shopping cart' },
] as const

export default function WebsiteStarter({ hasBrief, onStart, onWrite }: {
  hasBrief: boolean; onStart: (brief: string, style: string) => void; onWrite: () => void
}) {
  const [selected, setSelected] = useState(0)
  const direction = DIRECTIONS[selected]
  return <section className="website-starter" aria-label="Website starting points">
    <div className="website-starter-copy">
      <span className="website-starter-eyebrow"><Globe size={15} />A home for your next idea</span>
      <h3>From a spark<br /> to a standout site.</h3>
      <p>Explore a starting point, then make it yours. Your words, your style, your website.</p>
      <div className="website-starter-directions" aria-label="Website direction">{DIRECTIONS.map((item, index) => <button key={item.key} aria-pressed={index === selected} onClick={() => setSelected(index)}>{index === selected && <Check size={13} />}{item.label}</button>)}</div>
      <button className="website-starter-primary" onClick={() => onStart(direction.brief, direction.style)}>{hasBrief ? 'Continue your brief' : 'Use this starting point'}<ArrowRight size={17} /></button>
      {!hasBrief && <button className="website-starter-own" onClick={onWrite}>Or write your own brief<ArrowUpRight size={14} /></button>}
    </div>
    <div className="website-starter-showcase">
      <div className="website-starter-sample-label"><span>Inspiration preview</span><span>Make it your own</span></div>
      <div className={`website-starter-browser website-starter-${direction.key}`} aria-hidden="true">
        <div className="website-starter-browser-bar"><span><i /><i /><i /></span><span><Lock size={9} />your-website.com</span><ArrowUpRight size={11} /></div>
        <div className="website-starter-page">
          <div className="website-starter-nav"><strong>{direction.brand}</strong><span>Explore&nbsp;&nbsp; About&nbsp;&nbsp; Contact <ArrowUpRight size={11} /></span></div>
          <div className="website-starter-hero">
            <div className="website-starter-demo-copy"><span>{direction.eyebrow}</span><h4>{direction.headline}</h4><p>{direction.caption}</p><div>{direction.cta}<ArrowUpRight size={13} /></div></div>
            <div className="website-starter-art"><span className="website-starter-orbit" /><span className="website-starter-slab back" /><span className="website-starter-slab front" /><span className="website-starter-sun" /></div>
          </div>
          <div className="website-starter-demo-footer"><span>A considered beginning</span><div><span /><span /><span /></div><ArrowRight size={16} /></div>
        </div>
      </div>
      <p className="website-starter-note">A little inspiration. Your generated website will take this space.</p>
    </div>
  </section>
}
