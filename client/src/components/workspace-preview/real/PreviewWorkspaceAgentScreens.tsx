import WorkspaceAgentScreens, { type WorkspaceAgentScreensProps } from './WorkspaceAgentScreens'
import { useWorkspaceActivity } from './useWorkspaceActivity'

type Props = Omit<WorkspaceAgentScreensProps, 'activity'> & { activeChatIds: string[] }
function PreviewActivity(props: Props) {
  const activity = useWorkspaceActivity(props)
  return <WorkspaceAgentScreens {...props} activity={{ ...activity, demo: { playing: activity.playing, setPlaying: activity.setPlaying, reset: activity.resetDemo } }}/>
}
export default function PreviewWorkspaceAgentScreens(props: Props) {
  return import.meta.env.DEV ? <PreviewActivity {...props}/> : null
}
