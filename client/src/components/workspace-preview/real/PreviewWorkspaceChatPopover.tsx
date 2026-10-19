import WorkspaceChatPopover, { type WorkspaceChatPopoverProps } from './WorkspaceChatPopover'
import useSwarmPreview from './useSwarmPreview'

export type PreviewWorkspaceChatPopoverProps = Omit<WorkspaceChatPopoverProps, 'swarm'>

/** Isolated local sample wiring. Production imports the presentation directly. */
export default function PreviewWorkspaceChatPopover(props: PreviewWorkspaceChatPopoverProps) {
  const swarm = useSwarmPreview()
  return <WorkspaceChatPopover {...props} swarm={swarm}/>
}
