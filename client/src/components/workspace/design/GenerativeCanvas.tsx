import { lazy, Suspense, useState, type ReactNode } from 'react'
import { ArrowUpRight, MessageSquare, RotateCcw } from 'lucide-react'
import Markdown from '../Markdown'
import BuildCopy from '../../landing/BuildCopy'
const MapPanel = lazy(() => import('../MapPanel'))
const WorkflowBuilder = lazy(() => import('../AgentsPanel'))
const ConnectionManager = lazy(() => import('../ConnectionManager'))
function Connections() {
  const [open, setOpen] = useState(true)
  return open ? <Suspense fallback={<p>Loading your connected accounts…</p>}><ConnectionManager embedded onClose={() => setOpen(false)} onChange={() => {}}/></Suspense> : <button className="generative-action" onClick={() => setOpen(true)}>Manage connected accounts</button>
}
import { calculate, mapRequestForQuery, type GenerativeUi, type UiBlock, type UiValues } from './generativeUi'

function Block({ block, values, onChange, onAction, busy, agents }: { agents?: ReactNode; block: UiBlock; values: UiValues; onChange: (key: string, value: string | boolean) => void; onAction: (prompt: string) => void; busy: boolean }) {
  const key = (id: string) => `${block.id}:${id}`
  const fields = Object.fromEntries((block.fields || []).map(field => [field.id, String(values[key(field.id)] ?? field.value)]))
  const act = (prompt: string) => onAction(`${prompt.replace(/\{\{([a-zA-Z][a-zA-Z0-9_-]*)\}\}/g, (original, id) => fields[id] ?? original)}${block.fields?.length ? `\n\nMy current inputs:\n${block.fields.map(f => `${f.label}: ${fields[f.id]}`).join('\n')}` : ''}`)
  const formFields = <div className="generative-fields">{block.fields?.map(field => <label key={field.id}><span><BuildCopy text={field.label}/></span>{field.type === 'textarea'
    ? <textarea value={fields[field.id]} onChange={event => onChange(key(field.id), event.target.value)}/>
    : <input type={field.type} step={field.type === 'number' ? 'any' : undefined} value={fields[field.id]} onChange={event => onChange(key(field.id), event.target.value)}/>}</label>)}</div>
  const actions = <div className="generative-actions">{block.actions?.map((action, index) => <button key={index} className="generative-action" disabled={busy} onClick={() => act(action.prompt)}><BuildCopy text={action.label}/><ArrowUpRight size={14}/></button>)}</div>
  let content: ReactNode
  switch (block.type) {
    case 'connections': content = <Connections/>; break
    case 'agents': content = <div className="generative-inline-agents">{agents}</div>; break
    case 'workflow': content = <div className="generative-inline-workflow"><Suspense fallback={<p>Opening your workflow…</p>}><WorkflowBuilder/></Suspense></div>; break
    case 'map': content = <div className="generative-live-map"><Suspense fallback={<p>Opening your map…</p>}><MapPanel key={block.query} request={block.query ? mapRequestForQuery(block.query) : undefined}/></Suspense></div>; break
    case 'text': content = <Markdown>{block.text || ''}</Markdown>; break
    case 'metrics': content = <div className="generative-metrics">{block.items?.map(item => <div className="generative-metric" key={item.id}><small><BuildCopy text={item.label}/></small><strong><BuildCopy text={item.value || '—'}/></strong>{item.detail && <p>{item.detail}</p>}</div>)}</div>; break
    case 'table': {
      const sortKey = Number(values[key('sort')] ?? -1), descending = values[key('descending')] === true
      const filter = String(values[key('filter')] || '').toLowerCase()
      const rows = (block.rows || []).filter(row => !filter || row.some(cell => cell.toLowerCase().includes(filter)))
      if (sortKey >= 0) rows.sort((a, b) => (a[sortKey] || '').localeCompare(b[sortKey] || '', undefined, { numeric: true }) * (descending ? -1 : 1))
      content = <>{(block.rows?.length || 0) > 8 && <input className="generative-table-filter" aria-label={`Filter ${block.title}`} placeholder="Filter rows…" value={String(values[key('filter')] || '')} onChange={e => onChange(key('filter'), e.target.value)}/>}
        <div className="generative-table-scroll"><table className="generative-table"><thead><tr>{block.columns?.map((column, i) => <th key={i} aria-sort={sortKey === i ? descending ? 'descending' : 'ascending' : 'none'}><button onClick={() => { onChange(key('sort'), String(i)); onChange(key('descending'), sortKey === i && !descending) }}>{column}{sortKey === i ? descending ? ' ↓' : ' ↑' : ''}</button></th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{block.columns?.map((_, j) => <td key={j}>{row[j] || '—'}</td>)}</tr>)}</tbody></table>{!rows.length && <p>No matching rows.</p>}</div></>
      break
    }
    case 'chart': {
      const items = (block.items || []).map(item => ({ ...item, number: Number(item.value) })).filter(item => item.value.trim() && Number.isFinite(item.number))
      const max = Math.max(...items.map(item => Math.abs(item.number)), 1)
      content = <div role="img" aria-label={items.map(item => `${item.label}: ${item.value}`).join('; ')}>{items.map(item => <div className="generative-chart-row" key={item.id}><span>{item.label}</span><div className="generative-chart-bar"><i style={{ width: `${Math.abs(item.number) / max * 100}%`, background: item.number < 0 ? '#aa735b' : undefined }}/></div><strong>{item.value}</strong></div>)}{!items.length && <p>No numeric data was supplied yet.</p>}</div>
      break
    }
    case 'checklist': content = <div>{block.items?.map(item => <label key={item.id} className="generative-check"><input type="checkbox" checked={typeof values[key(item.id)] === 'boolean' ? Boolean(values[key(item.id)]) : item.checked} onChange={event => onChange(key(item.id), event.target.checked)}/><span><BuildCopy text={item.label}/>{item.detail && <small>{item.detail}</small>}</span></label>)}</div>; break
    case 'form': content = <>{block.text && <p>{block.text}</p>}{formFields}{actions}</>; break
    case 'calculator': content = <>{block.text && <p>{block.text}</p>}{formFields}{block.calculations?.map((calculation, i) => {
      const value = calculate(calculation.formula, fields)
      return <div className="generative-calculation" key={i}><span>{calculation.label}</span><output aria-live="polite">{value == null ? 'Enter valid inputs' : new Intl.NumberFormat('en-US', { style: calculation.format === 'currency' ? 'currency' : calculation.format === 'percent' ? 'percent' : 'decimal', ...(calculation.format === 'currency' ? { currency: 'USD' } : {}), maximumFractionDigits: 2 }).format(value)}</output></div>
    })}{actions}</>; break
    case 'actions': content = <>{block.text && <p>{block.text}</p>}{actions}</>; break
  }
  return <section className="generative-block" data-width={block.width} data-block-id={block.id} data-block-type={block.type}><h2><BuildCopy text={block.title}/></h2>{content}
    {!!block.sources?.length && <footer className="generative-sources">{block.sources.map((source, index) => <a key={index} href={source.url} target="_blank" rel="noopener noreferrer">{source.label}<ArrowUpRight size={11}/></a>)}</footer>}
  </section>
}
export default function GenerativeCanvas({ ui, values, text, title, busy, partial, loading, composer, artifacts, clarification, agents, onChange, onAction, onConversation, onRetry }: {
  ui?: GenerativeUi; values: UiValues; text: string; title: string; busy: boolean; partial?: boolean; loading?: string
  composer: ReactNode; agents?: ReactNode; artifacts?: ReactNode; clarification?: ReactNode
  onChange: (key: string, value: string | boolean) => void; onAction: (prompt: string) => void; onConversation: () => void; onRetry: () => void
}) {
  return <section className="generative-canvas" aria-label="Generated workspace" aria-busy={busy}>
    <header className="generative-canvas-header"><div><span className="generative-eyebrow">{busy ? <span className="generative-building"><i/>{ui ? 'YOUR WORKSPACE IS TAKING SHAPE' : loading ? `CREATING YOUR ${loading.toUpperCase()}` : 'THINKING WITH YOU'}</span> : partial ? 'SAVED PARTIAL WORKSPACE' : 'YOUR NALU WORKSPACE'}</span>
      <h1><BuildCopy text={ui?.title || title}/></h1>{ui?.description && <p><BuildCopy text={ui.description}/></p>}</div>
      <div className="generative-canvas-toolbar"><button onClick={onConversation}><MessageSquare size={14}/> Conversation</button>{!busy && <button onClick={onRetry}><RotateCcw size={13}/> Retry</button>}</div>
    </header>
    <div className="generative-grid">
      {ui?.blocks.map(block => <Block key={block.id} block={block} values={values} onChange={onChange} onAction={onAction} busy={busy} agents={agents}/>)}
      {!ui?.blocks.length && text && <section className="generative-block generative-text" data-width="full"><Markdown>{text}</Markdown>{clarification}</section>}
      {!ui?.blocks.length && !text && !artifacts && <div className="generative-empty generative-text" role="status"><i/><span>{busy ? 'Nalu is building a workspace for your question…' : 'Your work will appear here. Ask Nalu to get started.'}</span></div>}
      {ui?.blocks.length && clarification ? <div className="generative-block" data-width="full">{clarification}</div> : null}
      {artifacts && <section className="generative-block" data-width="full">{artifacts}</section>}
      {ui && text.includes('⚠️') && <div className="generative-block" data-width="full" role="alert"><Markdown>{text}</Markdown></div>}
    </div>
    <div className="generative-composer">{composer}</div>
  </section>
}
