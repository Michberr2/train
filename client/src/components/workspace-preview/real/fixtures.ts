// Synthetic examples for the isolated local design-review origin only.
export const PREVIEW_OWNER = 'nalu-workspace-design-preview'
export const PREVIEW_TOKEN = 'local-only-workspace-design-preview-v1'
export const PREVIEW_VERSION = 'functional-workspace-v1'
export const previewDocumentDesign = {
  light: { bg: '#F7F5F1', surface: '#FFFFFF', ink: '#173E39', muted: '#52675F', accent: '#23594B' },
  fonts: { display: 'Georgia', body: 'Inter', displaySerif: true, bodySerif: false },
}

const website = `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Coastal launch website</title><style>*{box-sizing:border-box}body{margin:0;background:#f8f7f0;color:#173e39;font:16px/1.6 system-ui}header{display:flex;justify-content:space-between;padding:26px 7%;border-bottom:1px solid #cddbd3}main{padding:56px 7%;max-width:980px;margin:auto}small{letter-spacing:.15em;text-transform:uppercase}h1{font:clamp(36px,7vw,72px)/1.05 Georgia;margin:20px 0}p{max-width:520px;color:#52675f}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:36px 0}.grid article{background:#e9efe7;padding:22px;border:1px solid #d8e2d6}button{border:0;background:#23594b;color:white;padding:13px 20px;border-radius:4px;font:inherit;cursor:pointer}#details{padding:20px;border-left:3px solid #23594b;background:#e9efe7}@media(max-width:500px){main{padding-top:30px}.grid{grid-template-columns:1fr}}</style></head><body><header><strong>COASTAL / STUDIO</strong><span>A little more possibility.</span></header><main><small>A sample Studio creation</small><h1>Good ideas.<br>Room to grow.</h1><p>A calm place to turn a first thought into something people can use. Built for a launch that feels considered, from the first click.</p><button onclick="document.getElementById('details').hidden=false">Explore the launch</button><div class="grid"><article><strong>01 / Discover</strong><p>A clear brief and a shared direction.</p></article><article><strong>02 / Create</strong><p>Thoughtful pages, useful stories, real work.</p></article><article><strong>03 / Launch</strong><p>A small release with room for feedback.</p></article></div><section id="details" hidden>This sample website is interactive. Your real Studio uses this same preview, editor, and export experience.</section></main></body></html>`

const now = new Date('2026-10-18T14:00:00Z').getTime()
const chat = (id: string, title: string, artifact: Record<string, unknown>, i: number) => ({
  id: `preview-${id}`, title, createdAt: now - i * 60_000,
  messages: [
    { id: `preview-${id}-request`, role: 'user', content: `Create ${title.toLowerCase()} for our coastal launch.`, updatedAt: now },
    { id: `preview-${id}-result`, role: 'assistant', content: 'A saved sample creation, ready to open, inspect, and export.', updatedAt: now + 1, ...artifact },
  ],
})

export const previewChats = [
  chat('website', 'Coastal launch website', { design: { kind: 'webpage', name: 'Coastal launch website', html: website } }, 0),
  chat('brief', 'Launch brief', { doc: {
    title: 'Launch brief', subtitle: 'Coastal Studio · A working example',
    design: previewDocumentDesign,
    blocks: [
      { type: 'heading', level: 1, text: 'Make the first release useful.' },
      { type: 'paragraph', text: 'This sample brief keeps the project grounded in three things: a clear audience, one useful promise, and a release small enough to learn from.' },
      { type: 'heading', level: 2, text: 'The plan' },
      { type: 'table', columns: ['Workstream', 'Owner', 'Next step'], rows: [['Website', 'Design', 'Review the first page'], ['Content', 'Studio', 'Finalize the launch story'], ['Operations', 'Autopilot', 'Prepare the weekly brief']] },
      { type: 'heading', level: 2, text: 'Ready for review' },
      { type: 'bullets', items: ['Check the headline against the product promise.', 'Review the budget and assign a launch owner.', 'Share the first release with a small group of customers.'] },
    ],
  } }, 1),
  chat('budget', 'Launch budget', { sheet: { title: 'Launch budget', sheets: [{ name: 'Plan', columns: ['Workstream', 'Budget', 'Actual', 'Remaining'], rows: [['Design', 4200, 2800, '=B2-C2'], ['Content', 2400, 1800, '=B3-C3'], ['Research', 1800, 1200, '=B4-C4'], ['Total', '=SUM(B2:B4)', '=SUM(C2:C4)', '=SUM(D2:D4)']] }] } }, 2),
  chat('story', 'Launch story', { deck: { title: 'Launch story', subtitle: 'Coastal Studio', slides: [{ layout: 'title', title: 'A thoughtful first release', subtitle: 'Good ideas. Room to grow.' }, { title: 'Built around useful work', bullets: ['A clear place to start', 'Tools that keep the details visible', 'An easy path from idea to review'] }, { title: 'A small launch, then learn', bullets: ['Invite a focused first group', 'Watch where the work slows down', 'Improve what people use most'] }] } }, 3),
  chat('palette', 'Coastal palette', { design: { kind: 'palette', name: 'Coastal palette', description: 'A calm palette with readable working surfaces.', fonts: { heading: 'Georgia', body: 'Inter' }, colors: [{ role: 'Primary', name: 'Pine', hex: '#23594B', usage: 'Main actions and selected controls' }, { role: 'Background', name: 'Paper', hex: '#F8F7F0', usage: 'Large reading surfaces' }, { role: 'Text', name: 'Ink', hex: '#173E39', usage: 'Headings and body text' }, { role: 'Accent', name: 'Sage', hex: '#B7CCBC', usage: 'Quiet highlights and supporting illustration' }] } }, 4),
]

export const previewFlow = {
  id: 'preview-launch-review', name: 'Launch review', enabled: false, schedule: 'manual', time: '09:00',
  nodes: [
    { id: 'preview-context', type: 'trigger', label: 'Collect context', prompt: 'Sample launch: website, brief, and budget are ready for review.', x: 40, y: 80 },
    { id: 'preview-plan', type: 'agent', agent: 'general', label: 'Prepare a review', prompt: 'Prepare a concise review of the launch materials.\n\n{{input}}', x: 380, y: 80 },
    { id: 'preview-approve', type: 'approval', label: 'Your approval', prompt: '', x: 720, y: 80 },
    { id: 'preview-output', type: 'textfile', label: 'Save the brief', prompt: '{{input}}', x: 1060, y: 80 },
  ],
  edges: [{ from: 'preview-context', to: 'preview-plan' }, { from: 'preview-plan', to: 'preview-approve' }, { from: 'preview-approve', to: 'preview-output' }],
}
