import WorkspaceLiveHub, { type HubProps } from './WorkspaceLiveHub'
import { useWorkspaceActivity } from './useWorkspaceActivity'

type Props = Omit<HubProps, 'activity'> & { activeChatIds: string[] }
function PreviewActivity(props: Props) {
  const activity = useWorkspaceActivity(props)
  return <WorkspaceLiveHub {...props} activity={{ ...activity, demo: { playing: activity.playing, setPlaying: activity.setPlaying, reset: activity.resetDemo } }}/>
}
export default function PreviewWorkspaceLiveHub(props: Props) {
  return import.meta.env.DEV ? <PreviewActivity {...props}/> : null
}
