import type { SwarmAgentProfile } from '../../workspace/design/swarmTypes'

const COATS = ['#343434', '#8a6a50', '#e1bd8d', '#dad8d2', '#667887', '#a96e68', '#747d5e', '#f0eee7']
const MARKINGS = ['#f2eee4', '#343434', '#b8d2df', '#d19b57', '#c1b5a2', '#8e9d74']
const EYES = ['#c99a42', '#614b3a', '#82aeca', '#8c9b67']
const hash = (value: string) => [...value].reduce((n, char) => (n * 31 + char.charCodeAt(0)) >>> 0, 7)
export function dogAppearanceFor(name: string): NonNullable<SwarmAgentProfile['appearance']> {
  const seed = hash(name)
  return { coat: seed % COATS.length, ears: Math.floor(seed / 7) % 4, markings: Math.floor(seed / 17) % 6, eyes: Math.floor(seed / 29) % 4 }
}
export default function DogAgentAvatar({ name, appearance, size = 30 }: { name: string; appearance?: SwarmAgentProfile['appearance']; size?: number }) {
  const look = appearance || dogAppearanceFor(name)
  const coat = COATS[((look.coat % COATS.length) + COATS.length) % COATS.length]
  const patch = MARKINGS[((look.markings % MARKINGS.length) + MARKINGS.length) % MARKINGS.length]
  const eye = EYES[((look.eyes % EYES.length) + EYES.length) % EYES.length]
  const ears = ((look.ears % 4) + 4) % 4
  const earPath = ears === 0 ? 'M29 38 18 12Q17 7 22 10L43 28M71 28 90 10Q95 7 93 14L83 40' : ears === 1 ? 'M30 37 29 7Q30 3 34 7L51 28M68 28 85 6Q89 3 90 8L80 40' : ears === 2 ? 'M29 34 16 23Q10 16 17 14L44 27M73 27 94 14Q101 15 96 23L82 38' : 'M29 37 19 18Q17 13 23 14L45 28M70 28 87 13Q94 11 91 20L82 38'
  return <svg width={size} height={size} viewBox="0 0 112 112" aria-hidden="true" className="dog-agent-avatar">
    <circle cx="56" cy="56" r="54" fill="#f1f3f5"/>
    <path d={earPath} fill={coat} stroke="#292b2e" strokeWidth="3" strokeLinejoin="round"/>
    <path d="M24 54Q24 30 42 25Q56 20 70 25Q89 31 89 54V65Q88 91 57 96Q26 92 23 68Z" fill={coat} stroke="#292b2e" strokeWidth="3"/>
    {look.markings % 3 === 0 ? <path d="M57 26Q48 43 50 59Q51 68 56 70Q63 67 64 55Q65 40 57 26Z" fill={patch}/> : look.markings % 3 === 1 ? <ellipse cx="75" cy="47" rx="11" ry="13" fill={patch}/> : <path d="M31 68Q53 59 81 68Q74 88 56 90Q38 87 31 68Z" fill={patch}/>}
    <ellipse cx="42" cy="54" rx="4.5" ry="5.5" fill={eye}/><ellipse cx="70" cy="54" rx="4.5" ry="5.5" fill={eye}/>
    <ellipse cx="43" cy="54" rx="1.7" ry="2.4" fill="#161718"/><ellipse cx="71" cy="54" rx="1.7" ry="2.4" fill="#161718"/>
    <path d="M49 68Q56 63 63 68Q62 74 56 74Q50 74 49 68Z" fill="#252628"/>
    <path d="M56 74Q54 81 48 80M56 74Q58 81 64 80" fill="none" stroke="#353331" strokeWidth="2.5" strokeLinecap="round"/>
  </svg>
}
