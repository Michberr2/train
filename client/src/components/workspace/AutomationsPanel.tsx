import { lazy, Suspense } from 'react'

const AgentsPanel = lazy(() => import('./AgentsPanel'))

// Recurring tasks use the same durable run engine, schedules, and outputs as Autopilot.
// AgentsPanel imports existing nalu-automations definitions once, disabled. The
// original saved definitions remain untouched, including unsupported schedules.
export default function AutomationsPanel() {
  let hasLegacy = false
  try { hasLegacy = Array.isArray(JSON.parse(localStorage.getItem('nalu-automations') || 'null')) } catch { /* no saved tasks */ }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {hasLegacy && (
        <p role="status" className="border-b border-glass/10 bg-panel2 px-5 py-2 text-xs text-dim">
          Your saved tasks are available in Autopilot. Imported tasks start off; review their schedules before enabling. Friday schedules start as Manual.
        </p>
      )}
      <Suspense fallback={<div className="p-5 text-sm text-dim">Loading Autopilot…</div>}>
        <AgentsPanel />
      </Suspense>
    </div>
  )
}
