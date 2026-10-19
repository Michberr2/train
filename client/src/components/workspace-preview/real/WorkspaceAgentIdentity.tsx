import NaluMark from '../../landing/NaluMark'
import type { ActivityItem } from '../../workspace/design/workspaceActivity'

export type AgentName = 'Nalu' | 'Rocky' | 'Milo'

/** Real Swarm work supplies its assigned identity. Ordinary chats and CLI work
 * remain attributed to Nalu; only the isolated fixtures use sample mappings. */
export function agentForItem(item: ActivityItem): { name: AgentName } {
  if (item.swarm) return { name: item.swarm.agent }
  if (item.preview) {
    const chatId = item.chatId || item.id.replace(/^sample-work:/, '')
    if (chatId === 'preview-budget') return { name: 'Rocky' }
    if (chatId === 'preview-brief') return { name: 'Milo' }
  }
  return { name: 'Nalu' }
}

// Exact 2D caps of createFriend's closed heads in ../../naluFriends.ts. The
// curve coordinates, folded ear, patches, flecks and coat colors come from the
// landing characters; flipping Y converts Three's coordinates to SVG's.
const MILO_HEAD = 'M-.46-.38C-.6-.14-.59.19-.45.37C-.32.52-.04.54.18.43Q.33.35.37.17Q.51.035.79.025Q.98.035 1.025-.075Q1.055-.19.985-.3Q.96-.39.71-.43Q.33-.49-.04-.47Q-.26-.52-.46-.38Z'
const ROCKY_HEAD = 'M-.5-.31C-.65-.06-.59.27-.48.45C-.67.81-.56 1.07-.42 1.1C-.23 1.12-.08.68-.12.5L.11.51C.11.87.29 1.12.43 1.04C.6.91.52.55.43.4Q.69.25.65.03Q.91.03.89-.19C.94-.43.65-.57.45-.46Q.12-.67-.17-.44Z'
const MILO_EAR = 'M-.12.035C-.34.06-.52-.075-.5-.22Q-.47-.31-.3-.24C-.14-.15.015-.07.055.005Q-.005.085-.12.035Z'
function softPatch(points: number[][]): string {
  const last = points[points.length - 1]
  return `M${(last[0] + points[0][0]) / 2} ${(last[1] + points[0][1]) / 2}`
    + points.map(([x, y], i) => { const next = points[(i + 1) % points.length]; return `Q${x} ${y} ${(x + next[0]) / 2} ${(y + next[1]) / 2}` }).join('') + 'Z'
}
const MILO_MUZZLE = softPatch([[.53,0],[.78,.02],[.87,-.05],[.83,-.17],[.94,-.23],[.87,-.34],[.63,-.42],[.29,-.405],[.34,-.27],[.48,-.22],[.45,-.07]])
const MILO_BLAZE = softPatch([[.285,.35],[.34,.285],[.37,.17],[.43,.075],[.39,-.035],[.335,.08],[.305,.21]])
const MILO_FLECKS = [[.47,-.09,.02],[.6,-.035,.016],[.52,-.2,.014],[.69,-.19,.018],[.4,-.145,.013]]

export function AgentHead({ name, className = '' }: { name: AgentName; className?: string }) {
  if (name === 'Nalu') return <NaluMark className={`${className} agent-head-nalu`}/>
  const milo = name === 'Milo'
  return <svg className={className} viewBox={milo ? '-.86 -.93 1.98 1.98' : '-.76 -1.2 1.9 1.9'} fill="none" aria-hidden="true" data-agent-head={name}>
    <g transform="scale(1 -1)">
      <path d={milo ? MILO_HEAD : ROCKY_HEAD} fill={milo ? '#252526' : '#82786e'}/>
      {milo ? <>
        <path d={MILO_MUZZLE} fill="#c8c5bb"/>
        <path d={MILO_BLAZE} fill="#c8c5bb"/>
        {MILO_FLECKS.map(([x, y, r], i) => <ellipse key={i} cx={x} cy={y} rx={r} ry={r * .65} fill="#252526"/>)}
        <path d={MILO_EAR} transform="translate(-.24 .39)" fill="#252526" stroke="#202022" strokeWidth=".012"/>
      </> : <path d="M.48.09 .69.03 .84-.07 .88-.3 .64-.46 .39-.35 .37-.09Z" fill="#4a4745"/>}
    </g>
  </svg>
}
