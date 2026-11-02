import { useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useReducedMotion } from 'framer-motion'
import CursorBuilders from '../../landing/CursorBuilders'
import { BACKGROUNDS } from '../../../lib/backgroundAssets'
import '../../workspace-preview/real/workspace-refined.css'
import '../../workspace-preview/real/workspace-scenic.css'
import '../../workspace-preview/real/workspace-studio-scenic.css'
import '../../workspace-preview/real/workspace-utility-scenic.css'
import '../../workspace-preview/real/workspace-map-scenic.css'
import '../../workspace-preview/real/workspace-calm.css'
import '../../workspace-preview/real/workspace-launcher-shell.css'
import '../../workspace-preview/real/workspace-memory-refined.css'
import '../../workspace-preview/real/workspace-palette-consistency.css'
import '../../workspace-preview/real/workspace-desktop-shell.css'
import './workspace-design-surface.css'
import './workspace-panel-fit.css'
import './workspace-activity-fit.css'
import './workspace-chat-fit.css'
import './workspace-window-theme.css'
import './workspace-studio-theme.css'
import './workspace-glass.css'
import './workspace-tool-typography.css'
import './workspace-studio-interior.css'
import './workspace-map-memory-interior.css'
import './workspace-utility-interior.css'
import './workspace-adaptive.css'
import './generative-workspace.css'

/** Shared visual surface only. Authentication, storage and network access stay
 * with the caller; importing this component never initializes sample data. */
export default function WorkspaceDesignSurface({ children, preview = false }: { children: ReactNode; preview?: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const [paused, setPaused] = useState(false)
  const prefersReduced = useReducedMotion()
  const reduced = paused || !!prefersReduced
  return <div ref={host} className="nalu-design-review workspace-design-surface" data-workspace-design="true" data-generative-workspace="true" data-workspace-preview={preview || undefined}
    style={{ '--review-scene': `url(${BACKGROUNDS['/images/bg-meadow-sunset.png'].large})` } as CSSProperties}>
    <div className="review-desktop-scene" aria-hidden="true" />
    {children}
    {!preview && <><button className="generative-motion" aria-label={paused ? 'Play cursor construction' : 'Pause cursor construction'} aria-pressed={paused} disabled={!!prefersReduced} onClick={() => setPaused(value => !value)}><span>MOTION</span><span>{reduced ? 'OFF' : 'ON'}</span></button><CursorBuilders container={host} reduced={reduced} active workspace/></>}
  </div>
}
