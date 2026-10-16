import type { WebsiteQuality } from './types'

/** Describe the checks for this revision without claiming exhaustive testing. */
export default function StudioValidation({ quality }: { quality?: WebsiteQuality }) {
  const runtime = quality?.runtime
  const label = runtime?.status === 'passed'
    ? 'Built · browser checks passed'
    : runtime?.status === 'partial'
      ? 'Built · interaction checks incomplete'
      : runtime?.status === 'failed'
        ? 'Browser checks found problems'
        : 'Browser checks unavailable for this version'
  const checks = Array.isArray(runtime?.checks) ? runtime.checks : []
  const limits = Array.isArray(runtime?.limitations) ? runtime.limitations : []
  return (
    <details className="border-t border-glass/10 px-2 py-2 text-xs text-ink">
      <summary className="cursor-pointer">{label}</summary>
      <div className="space-y-2 pt-2 text-dim">
        {runtime?.status === 'partial' && <p>The page passed basic browser checks. Its requested interactions still need testing.</p>}
        {!!checks.length && <p>{checks.filter(check => check.passed).length} of {checks.length} checks passed{runtime?.widths?.length ? ` at ${runtime.widths.join(' and ')}px` : ''}.</p>}
        {!!checks.length && <ul className="list-disc pl-4">{checks.map((check, index) => <li key={index}>{check.name} ({check.width}px): {check.passed ? 'passed' : 'failed'}</li>)}</ul>}
        {limits.map((limit, index) => <p key={index}>{limit}</p>)}
        <p>Try your own inputs before sharing. Connected services need a separate check.</p>
      </div>
    </details>
  )
}
