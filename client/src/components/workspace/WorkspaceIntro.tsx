import type { ReactNode } from 'react'
import NaluAvatar from '../avatar/NaluAvatar'

export default function WorkspaceIntro({ label, title, description, compact = false, children }: {
  label: string; title: string; description: string; compact?: boolean; children?: ReactNode
}) {
  return <header className={`ws-page-intro${compact ? ' ws-page-intro-compact' : ''}`}>
    <div className="ws-intro-copy">
      <span className="ws-eyebrow"><i />{label}</span>
      <h1>{title}</h1>
      <p>{description}</p>
      {children}
    </div>
    <NaluAvatar size={compact ? 132 : 228} />
  </header>
}
