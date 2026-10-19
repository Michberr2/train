import { lazy, Suspense, useState } from 'react'
import { BookOpen, Code2, FileText, Globe, Image, ListChecks, Presentation, Table2, Wand2 } from 'lucide-react'
const PluginsPanel = lazy(() => import('./PluginsPanel'))

type Skill = { id: string; name: string; description: string; action: string; draft?: string; icon: typeof BookOpen; help?: boolean }
const SKILLS: Skill[] = [
  { id: 'browser', name: 'Browser research', description: 'Research public websites with sources in chat. Use Nalu for Chrome for actions in your signed-in browser tabs.', action: 'Plan research', draft: 'Research this topic using public web sources, and cite what you find: ', icon: Globe },
  { id: 'documents', name: 'Documents', description: 'Draft and revise documents, then download Word or PDF files from the document preview.', action: 'Draft a document', draft: 'Create a document about ', icon: FileText },
  { id: 'image-gen', name: 'Images', description: 'Generate images from your description. Choose your subject, style and dimensions before sending.', action: 'Describe an image', draft: 'Generate an image of ', icon: Image },
  { id: 'nalu-docs', name: 'Workspace guide', description: 'See how chat, Studio, saved work and app connections fit together.', action: 'Read the guide', icon: BookOpen },
  { id: 'pdf', name: 'PDFs', description: 'Attach a PDF to discuss its contents, or create a document and export it as a PDF.', action: 'Prepare a PDF request', draft: 'Help me work with a PDF. I want to ', icon: FileText },
  { id: 'plugin-creator', name: 'Integration planning', description: 'Draft adapter code or setup instructions. Custom plugin installation is not available in this workspace.', action: 'Plan an integration', draft: 'Help me plan an integration for my app. Ask which platform and actions I need, then draft code and setup steps for review. Do not claim anything has been installed.', icon: Code2, help: true },
  { id: 'presentations', name: 'Presentations', description: 'Create and edit slide decks with downloadable PowerPoint and PDF exports.', action: 'Plan a presentation', draft: 'Create a presentation about ', icon: Presentation },
  { id: 'skill-creator', name: 'Reusable instructions', description: 'Write instructions you can review and reuse in your workflows. Drafting does not register an executable skill.', action: 'Draft instructions', draft: 'Help me write reusable instructions for a workflow. Ask about the task and tool that will use them, then produce a draft for review.', icon: Wand2, help: true },
  { id: 'skill-installer', name: 'Skill setup guidance', description: 'Get help reviewing setup steps for your chosen coding tool. Nalu does not install external skill runtimes here.', action: 'Ask about setup', draft: 'Help me review skill setup instructions for my coding tool. First ask which tool and skill repository I use. Do not claim to install or enable anything.', icon: ListChecks, help: true },
  { id: 'spreadsheets', name: 'Spreadsheets', description: 'Build spreadsheet workbooks with formulas and download them as Excel files.', action: 'Plan a workbook', draft: 'Create a spreadsheet workbook for ', icon: Table2 },
]

export default function SkillsPanel({ onDraft }: { onDraft?: (prompt: string) => void }) {
  const [tab, setTab] = useState<'tools' | 'connections'>('tools')
  const [guide, setGuide] = useState(false)
  return <div className="ws-skills ws-feature-page flex min-h-0 flex-1 flex-col font-sans text-ink">
    <header className="ws-utility-heading">
      <div><h1>Skills</h1><p>Choose a tool, then complete your request in chat.</p></div>
      <nav aria-label="Skills sections" className="ws-utility-segments">
      <button aria-pressed={tab === 'tools'} onClick={() => setTab('tools')} className="rounded-xl border border-glass/20 px-4 py-2 text-sm">Tools & guides</button>
      <button aria-pressed={tab === 'connections'} onClick={() => setTab('connections')} className="rounded-xl border border-glass/20 px-4 py-2 text-sm">Connections & Chrome</button>
      </nav>
    </header>
    {tab === 'connections' ? <Suspense fallback={<p role="status" className="p-6 text-sm text-dim">Opening connections…</p>}><PluginsPanel /></Suspense> : <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      {guide && <section aria-label="Workspace guide" className="mx-auto mb-4 max-w-5xl rounded-xl border border-glass/20 bg-glass/10 p-4 text-sm">
        <div className="mb-2 flex items-center justify-between gap-4"><h2 className="font-medium">Your workspace</h2><button onClick={() => setGuide(false)} className="rounded px-2 py-1 hover:bg-glass/10">Close guide</button></div>
        <ol className="list-inside list-decimal space-y-2 text-dim">
          <li>Use chat to explain what you need. Attach supported files to give Nalu context.</li>
          <li>Open Studio to choose a creation type, review its preview and download your work.</li>
          <li>Saved chats and creations let you return to an earlier draft.</li>
          <li>Use Connections to verify accounts and choose destinations for AutoPilot workflows.</li>
          <li>Nalu for Chrome is a separate extension you download and load in Chrome. It asks you to review consequential actions.</li>
        </ol>
      </section>}
      <ul className="ws-skill-cards mx-auto grid max-w-5xl gap-2">
        {SKILLS.map(skill => <li key={skill.id} className="flex flex-wrap items-center gap-4 rounded-xl border border-glass/[0.18] bg-glass/[0.11] px-4 py-3 backdrop-blur-2xl">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-glass/[0.06]"><skill.icon size={22} aria-hidden="true" /></div>
          <div className="min-w-0 flex-1"><h2 className="text-sm font-medium">{skill.name}{skill.help && <span className="ml-2 text-xs font-normal text-dim">Guidance</span>}</h2><p className="mt-1 text-sm text-dim">{skill.description}</p></div>
          <button disabled={!!skill.draft && !onDraft} onClick={() => skill.draft ? onDraft?.(skill.draft) : setGuide(open => !open)} aria-expanded={!skill.draft ? guide : undefined} className="rounded-xl border border-glass/20 px-3 py-2 text-xs hover:bg-glass/10 disabled:opacity-50">{skill.action}</button>
        </li>)}
      </ul>
    </div>}
  </div>
}
