import type { CSSProperties, ReactNode } from 'react'
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

/** Shared visual surface only. Authentication, storage and network access stay
 * with the caller; importing this component never initializes sample data. */
export default function WorkspaceDesignSurface({ children, preview = false }: { children: ReactNode; preview?: boolean }) {
  return <div className="nalu-design-review workspace-design-surface" data-workspace-design="true" data-workspace-preview={preview || undefined}
    style={{ '--review-scene': `url(${BACKGROUNDS['/images/bg-sandy-beach.png'].large})` } as CSSProperties}>
    <div className="review-desktop-scene" aria-hidden="true" />
    {children}
  </div>
}
