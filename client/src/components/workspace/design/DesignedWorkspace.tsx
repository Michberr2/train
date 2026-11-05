import type { ComponentProps } from 'react'
import Workspace from '../Workspace'
import WorkspaceDesignSurface from './WorkspaceDesignSurface'
import WorkspaceBuild from './WorkspaceBuild'

/** The authenticated app uses its existing account and data lifecycle. */
export default function DesignedWorkspace(props: Omit<ComponentProps<typeof Workspace>, 'designPreview' | 'designEnabled'>) {
  return <WorkspaceBuild><WorkspaceDesignSurface><Workspace {...props} designEnabled /></WorkspaceDesignSurface></WorkspaceBuild>
}
