import BuildCopy from '../../landing/BuildCopy'
import { ArrowUpRight } from 'lucide-react'
const capabilities = [
  ['Research & compare','Turn a question into clear findings, comparisons, and sources.','Help me research and compare '],
  ['Write & refine','Documents, emails, proposals, and words that sound like you.','Help me write '],
  ['Make something visual','Images, presentations, brands, video, 3D models, and visual ideas.','Create '],
  ['Build for the web','A website or interactive experience you can keep and edit.','Build a website for '],
  ['Work with numbers','Editable calculations, charts, models, and spreadsheets.','Help me analyze '],
  ['Explore a place','Maps, properties, nearby places, and location research.','Show me a map of '],
  ['Plan what happens next','Checklists, workflows, and steps you can act on.','Help me plan '],
  ['Work with agents','Coordinate a project and keep your agents’ work together.','Help me coordinate my agents for '],
  ['Remember & connect','Find past work and bring relevant context into this thought.','Help me find and build on my previous work about '],
  ['Connect your tools','Use connected accounts and the tools your work needs.','Help me connect '],
]
export default function GenerativeCapabilities({ onChoose, onClose }: { onChoose: (prompt: string) => void; onClose: () => void }) {
  return <section className="generative-capabilities" aria-label="Nalu capabilities"><header><span className="generative-eyebrow">ONE WORKSPACE. EVERY POSSIBILITY.</span><button onClick={onClose}>Back to your thought</button></header><h1><BuildCopy text="What’s on your mind?"/></h1><p>Choose a starting point, or just ask. Nalu brings the right tools into your workspace.</p><div>{capabilities.map(([name, detail, prompt]) => <button key={name} onClick={() => onChoose(prompt)}><span><h2><BuildCopy text={name}/></h2><p><BuildCopy text={detail}/></p></span><ArrowUpRight size={19}/></button>)}</div></section>
}
