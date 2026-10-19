import WorkspaceAgentTray, { type WorkspaceAgentTrayProps } from './WorkspaceAgentTray'
import { useWorkspaceActivity } from './useWorkspaceActivity'

type Props = Omit<WorkspaceAgentTrayProps, 'activity'> & { activeChatIds: string[] }
function PreviewActivity(props: Props) {
  const activity = useWorkspaceActivity(props)
  return <WorkspaceAgentTray {...props} activity={{ ...activity, demo: { playing: activity.playing, setPlaying: activity.setPlaying, reset: activity.resetDemo } }}/>
}
export default function PreviewWorkspaceAgentTray(props: Props) {
  return import.meta.env.DEV ? <PreviewActivity {...props}/> : null
}
