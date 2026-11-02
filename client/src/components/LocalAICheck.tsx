import { useState } from 'react'
import LocalAIControl from './workspace/LocalAIControl'
import { streamChat } from './workspace/agentApi'
import { handleLocalAIRequest } from '../lib/localAIRequests'
import { executeLocalSwarmJob } from '../lib/localSwarm'
import { planLocalSwarmWork } from '../lib/localSwarmPlan'

/** Development-only hardware check using the real inference and stream paths. */
export default function LocalAICheck() {
  const [prompt, setPrompt] = useState('What is 2 + 2? Reply with the number only.')
  const [answer, setAnswer] = useState(''), [route, setRoute] = useState(''), [busy, setBusy] = useState(false)
  const [controller, setController] = useState<AbortController>()
  const [kind, setKind] = useState('chat')
  const [diagnostics, setDiagnostics] = useState<{ stage: string; value: Record<string, unknown> }[]>([])
  const run = async () => {
    const abort = new AbortController(); setController(abort); setBusy(true); setAnswer(''); setRoute(''); setDiagnostics([])
    try {
      if (kind === 'chat') await streamChat([{ role: 'user', content: prompt }], undefined, { signal: abort.signal, onDelta: text => setAnswer(old => old + text), onError: text => setAnswer(old => old + text), onRoute: setRoute })
      else if (kind === 'swarm-plan') setAnswer(JSON.stringify(await planLocalSwarmWork(prompt, [], '', abort.signal, setRoute), null, 2))
      else if (kind.startsWith('swarm-')) {
        const owner = localStorage.getItem('nalu-token')
        const result = await executeLocalSwarmJob({ executionMode: 'device', id: 'hardware-check', projectId: 'hardware-check', thread: 'Rocky', speaker: 'Rocky', kind: kind === 'swarm-task' ? 'task' : 'reply', input: prompt, brief: 'A draft website is being reviewed. No building or deployment has happened.', context: [], leaseToken: 'development-only-no-server-claim', leaseUntil: Date.now() + 900000 }, { signal: abort.signal, current: () => { if (owner !== localStorage.getItem('nalu-token')) abort.abort(); abort.signal.throwIfAborted() }, onProgress: async progress => { setRoute(progress.message) } })
        setAnswer(JSON.stringify(result, null, 2))
      } else {
        const response = await handleLocalAIRequest(`/api/${kind}`, JSON.stringify({ prompt, ...(kind === 'design' ? { kind: 'webpage' } : {}) }), abort.signal, (stage, value) => setDiagnostics(old => [...old, { stage, value }]))
        setAnswer(JSON.stringify(await response.json(), null, 2))
      }
    } catch (error) { if (!abort.signal.aborted) setAnswer(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false); setController(undefined) }
  }
  return <main className="min-h-screen bg-panel p-8 text-ink"><div className="mx-auto max-w-2xl space-y-6"><p className="text-sm text-dim">Local development · real on-device inference · no account required</p><LocalAIControl panel /><label className="block">Check type<select className="ml-3 rounded border p-2" value={kind} onChange={event => setKind(event.target.value)}>{['chat', 'doc', 'sheet', 'slides', 'design', 'email', 'cad', 'swarm-plan', 'swarm-reply', 'swarm-task'].map(value => <option key={value}>{value}</option>)}</select></label><label className="block">Hardware check prompt<textarea className="mt-2 block w-full rounded-xl border border-glass/20 bg-panel2 p-3" value={prompt} onChange={event => setPrompt(event.target.value)} /></label><div className="flex gap-4"><button disabled={busy} onClick={() => void run()} className="rounded-lg bg-emerald-700 px-4 py-3 text-white">Run on this computer</button>{busy && <button onClick={() => controller?.abort()}>Stop</button>}</div><p role="status">{busy ? 'Running…' : 'Idle'} {route}</p><pre aria-label="Local model answer" className="whitespace-pre-wrap rounded-xl border border-glass/20 p-4">{answer}</pre><details><summary>Model stage diagnostics</summary><pre className="whitespace-pre-wrap">{JSON.stringify(diagnostics, null, 2)}</pre></details></div></main>
}
