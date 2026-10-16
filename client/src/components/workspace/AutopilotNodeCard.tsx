import { ArrowRight, CheckCircle2, Clock, Edit3, Loader2, Maximize2, type LucideIcon } from 'lucide-react'
import type { CSSProperties, PointerEvent } from 'react'
import { AUTOPILOT_NODE_WIDTH } from './autopilotConnections'

export default function AutopilotNodeCard({ node, meta, state, result, index, canvas, canvasOffset, connecting, onDrag, onInput, onOutput, onEdit, onResult }: {
  node: { id: string; label: string; prompt: string; type: string; x: number; y: number }
  meta: { name: string; icon: LucideIcon; tint: string }; state: string; result: string; index: number
  canvas: boolean; connecting: string | null
  canvasOffset: { x: number; y: number }
  onDrag: (e: PointerEvent) => void; onInput: () => void; onOutput: () => void; onEdit: () => void; onResult: () => void
}) {
  const status = state === 'idle' ? 'Ready' : state === 'done' ? 'Complete' : state === 'error' ? 'Needs attention' : state === 'awaiting' ? 'Review needed' : state[0].toUpperCase() + state.slice(1)
  return <article data-node="1" data-step-id={node.id} className={`ap-node ap-node-${state}`} aria-label={node.label}
    style={{ ...(canvas ? { position: 'absolute', left: node.x + canvasOffset.x, top: node.y + canvasOffset.y, width: AUTOPILOT_NODE_WIDTH } : {}), '--node-tint': meta.tint } as CSSProperties}>
    <div className="ap-node-heading" onPointerDown={canvas ? onDrag : undefined}>
      <span className="ap-node-icon"><meta.icon size={21} /></span>
      <div><span className="ap-node-kind">{meta.name}</span><h3 title={node.label}>{node.label}</h3></div>
      <span className="ap-node-number">{String(index + 1).padStart(2, '0')}</span>
    </div>
    {canvas && <>
      <button className={`ap-port ap-port-in ${connecting && connecting !== node.id ? 'is-connecting' : ''}`} aria-label={`Connect into ${node.label}`} disabled={!connecting || connecting === node.id} onClick={e => { e.stopPropagation(); onInput() }}><span /></button>
      <button className={`ap-port ap-port-out ${connecting === node.id ? 'is-connecting' : ''}`} aria-label={`Connect from ${node.label}`} aria-pressed={connecting === node.id} onClick={e => { e.stopPropagation(); onOutput() }}><span><ArrowRight size={11} /></span></button>
    </>}
    <p className="ap-node-summary">{node.prompt?.replace(/\{\{input\}\}/g, 'the previous result').replace(/\{\{item\}\}/g, 'the current item').trim() || (node.type === 'router' ? 'Send each update down the right path.' : node.type === 'approval' ? 'Pause here for your review.' : 'Choose what this step should do.')}</p>
    <div className="ap-node-status">{state === 'running' ? <Loader2 size={14} className="animate-spin" /> : state === 'done' ? <CheckCircle2 size={14} /> : <Clock size={14} />}<span>{status}</span></div>
    <div className="ap-node-actions"><button aria-label={`Edit ${node.label}`} onClick={onEdit}><Edit3 size={15} />Edit step</button>{result && <button aria-label={`View result for ${node.label}`} onClick={onResult}><Maximize2 size={14} />Result</button>}</div>
  </article>
}
