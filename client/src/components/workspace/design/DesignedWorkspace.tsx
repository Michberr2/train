import type { ComponentProps } from 'react'
import Workspace from '../Workspace'
import WorkspaceDesignSurface from './WorkspaceDesignSurface'

/** The authenticated app uses its existing account and data lifecycle. */
export default function DesignedWorkspace(props: Omit<ComponentProps<typeof Workspace>, 'designPreview' | 'designEnabled'>) {
  return <WorkspaceDesignSurface><Workspace {...props} designEnabled /></WorkspaceDesignSurface>
}
