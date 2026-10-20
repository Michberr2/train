import { useEffect, useState, type CSSProperties } from 'react'

export const HUMAN_AVATARS = [
  ...Array.from({ length: 9 }, (_, index) => `getriki-person-${index + 1}`),
  'getriki-woman',
] as const
export type HumanAvatarId = typeof HUMAN_AVATARS[number]
const STORAGE_KEY = 'nalu-human-avatar'
const PEOPLE_IMAGE = `${import.meta.env.BASE_URL}avatars/getriki-people.webp`
const WOMAN_IMAGE = `${import.meta.env.BASE_URL}avatars/getriki-woman.webp`
export function isHumanAvatarId(value: unknown): value is HumanAvatarId {
  return typeof value === 'string' && (HUMAN_AVATARS as readonly string[]).includes(value)
}
export function getHumanAvatar(): HumanAvatarId {
  try { const value = localStorage.getItem(STORAGE_KEY); return isHumanAvatarId(value) ? value : HUMAN_AVATARS[0] }
  catch { return HUMAN_AVATARS[0] }
}
export function setHumanAvatar(value: HumanAvatarId): void {
  localStorage.setItem(STORAGE_KEY, value)
  window.dispatchEvent(new Event('nalu-human-avatar-changed'))
}
export function humanAvatarLabel(value: HumanAvatarId): string {
  return value === 'getriki-woman' ? 'Riley' : `Person ${Number(value.slice(-1))}`
}

/** Profile avatar picker and compact conversation identity, using Getriki art. */
export default function HumanAvatar({ value, name, size = 40, className = '' }: {
  value?: HumanAvatarId; name?: string; size?: number; className?: string
}) {
  const [current, setCurrent] = useState<HumanAvatarId>(() => isHumanAvatarId(value) ? value : getHumanAvatar())
  useEffect(() => {
    if (isHumanAvatarId(value)) { setCurrent(value); return }
    const update = () => setCurrent(getHumanAvatar())
    window.addEventListener('nalu-human-avatar-changed', update)
    window.addEventListener('storage', update)
    return () => { window.removeEventListener('nalu-human-avatar-changed', update); window.removeEventListener('storage', update) }
  }, [value])
  const person = current === 'getriki-woman' ? undefined : Number(current.slice(-1)) - 1
  return <span className={`human-avatar ${className}`.trim()} style={{ width: size, height: size, backgroundImage: `url("${person === undefined ? WOMAN_IMAGE : PEOPLE_IMAGE}")`, backgroundSize: person === undefined ? 'cover' : '900% 500%', backgroundPosition: person === undefined ? 'center 22%' : `${(person / 8) * 100}% 0%` } as CSSProperties} role="img" aria-label={name ? `${name}'s avatar` : humanAvatarLabel(current)} />
}

export function HumanAvatarPicker({ value, onChange }: { value: HumanAvatarId; onChange: (value: HumanAvatarId) => void }) {
  return <div className="human-avatar-picker" role="group" aria-label="Choose your human avatar">
    {HUMAN_AVATARS.map(id => <button key={id} type="button" aria-label={`Choose ${humanAvatarLabel(id)} avatar`} aria-pressed={value === id} onClick={() => onChange(id)}>
      <HumanAvatar value={id} size={54}/><span>{humanAvatarLabel(id)}</span>
    </button>)}
  </div>
}
