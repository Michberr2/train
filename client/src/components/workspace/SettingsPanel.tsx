import WorkspaceIntro from './WorkspaceIntro'
import AiBudgetPanel from './AiBudgetPanel'
import { getBillingReturn } from '../../lib/billing'
import {
  Settings,
  User as UserIcon,
  Cpu,
  Palette,
  Server,
  LogOut,
  Moon,
  Sun,
  Info,
  Gauge,
  Globe,
  Zap,
  Check,
  Clapperboard,
  Phone,
} from 'lucide-react'
import { useState, useRef, useEffect } from 'react'
import { useTheme } from '../ThemeProvider'
import { useAuth } from '../AuthProvider'
import { updateProfile } from '../../lib/localAuth'
import { h3Available } from '../../lib/localH3'
import { canRecordOnDevice, hasWebGPU } from '../../lib/onDeviceVideo'
import {
  REASONING_LEVELS,
  REASONING_DESC,
  REASONING_LABEL,
  MIN_TOKENS,
  MAX_TOKENS,
  getModelSettings,
  setModelSettings,
  type ReasoningLevel,
} from '../../lib/naluSettings'

// The Nalu "Settings" panel.

interface Props {
  displayName?: string
  onLogout?: () => void
}

export default function SettingsPanel({ displayName, onLogout }: Props) {
  const name = displayName?.trim() || 'You'
  const initial = name.charAt(0).toUpperCase()
  const { isDark, toggleTheme } = useTheme()
  const [{ reasoning, maxTokens, webSearch, streaming }, setSettings] = useState(getModelSettings())
  // Settings persist the instant you change them (naluSettings → localStorage). This
  // flashes a "Saved" confirmation so it's obvious the change stuck.
  const [category, setCategory] = useState(() => getBillingReturn() ? 'Support Nalu' : 'Account')
  const [saved, setSaved] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashSaved = () => {
    setSaved(true)
    if (savedTimer.current) clearTimeout(savedTimer.current)
    savedTimer.current = setTimeout(() => setSaved(false), 1600)
  }
  const pickReasoning = (r: ReasoningLevel) => { setSettings(setModelSettings({ reasoning: r })); flashSaved() }
  const pickTokens = (t: number) => { setSettings(setModelSettings({ maxTokens: t })); flashSaved() }
  const toggleWeb = () => { setSettings(setModelSettings({ webSearch: !webSearch })); flashSaved() }
  const toggleStream = () => { setSettings(setModelSettings({ streaming: !streaming })); flashSaved() }

  return (
    // flex-1 + min-h-0 (NOT h-full, which overflowed past the header and cut off the
    // bottom): fills the space under the top bar so the body scrolls to the very end.
    <div className="ws-settings ws-feature-page flex flex-1 min-h-0 flex-col text-ink font-sans">
      {/* Body — min-h-0 so this flex child can shrink and actually scroll; extra
          bottom padding so the last section clears the viewport edge. */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="ws-settings-content max-w-2xl mx-auto px-6 pt-6 pb-6">
          <WorkspaceIntro label="Your Nalu" title="Make yourself at home." description="Your account, your preferences, your way of working.">
            <span role="status" className="ws-save-status">{saved ? 'Changes saved' : 'Preferences save automatically'}</span>
          </WorkspaceIntro>
          <nav className="ws-segments flex-wrap" aria-label="Settings categories">
            {['Account', 'Support Nalu', 'Thinking', 'Video & engine'].map(item => <button key={item} aria-pressed={category === item} onClick={() => setCategory(item)}>{item}</button>)}
          </nav>
          <div className="ws-settings-group" hidden={category !== 'Account'}>
          {/* Account */}
          <Section icon={<UserIcon size={15} />} title="Account" desc="Signed-in identity">
            <div className="flex items-center gap-3 rounded-xl border border-glass/[0.18] bg-glass/[0.11] backdrop-blur-2xl px-4 py-3.5">
              <div className="w-10 h-10 rounded-full bg-glass/10 flex items-center justify-center text-sm font-medium shrink-0">
                {initial}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-ink truncate">{name}</div>
                <div className="text-xs text-dim">Nalu account</div>
              </div>
              <button
                onClick={onLogout}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm bg-glass/5 hover:bg-glass/10 text-ink transition-colors shrink-0"
              >
                <LogOut size={14} /> Sign out
              </button>
            </div>
          </Section>

          {/* Appearance */}
          <Section icon={<Palette size={15} />} title="Appearance" desc="Theme and visual style">
            <button
              onClick={(e) => toggleTheme(e)}
              className="w-full flex items-center gap-3 rounded-xl border border-glass/[0.18] bg-glass/[0.11] backdrop-blur-2xl px-4 py-3.5 text-left transition-colors hover:bg-glass/[0.16]"
            >
              <div className="w-9 h-9 rounded-lg bg-glass/5 flex items-center justify-center shrink-0">
                {isDark ? <Moon size={16} className="text-dim" /> : <Sun size={16} className="text-dim" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-ink">Theme</div>
                <div className="text-xs text-dim">{isDark ? 'Dark — tap to switch to light' : 'Light — tap to switch to dark'}</div>
              </div>
              <span className="rounded-full bg-emerald-500/20 px-2.5 py-1 text-xs font-medium text-emerald-300 shrink-0">
                {isDark ? 'Dark' : 'Light'}
              </span>
            </button>
          </Section>

          {/* Phone — for the phone-call feature (Nalu can call this number). */}
          <PhoneSection />

          </div>
          {category === 'Support Nalu' && <div className="ws-settings-group"><AiBudgetPanel /></div>}
          <div className="ws-settings-group" hidden={category !== 'Thinking'}>
          {/* Reasoning & capacity */}
          <Section icon={<Gauge size={15} />} title="Reasoning &amp; capacity" desc="How hard Nalu thinks + answer length">
            <div className="rounded-xl border border-glass/[0.18] bg-glass/[0.11] backdrop-blur-2xl px-4 py-3.5 space-y-4">
              <div>
                <div className="text-sm font-medium text-ink mb-2">Reasoning level</div>
                <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
                  {REASONING_LEVELS.map((lvl) => (
                    <button
                      key={lvl}
                      onClick={() => pickReasoning(lvl)}
                      className={`rounded-lg px-2 py-2 text-xs font-medium transition-colors ${
                        reasoning === lvl ? 'bg-gold text-black' : 'bg-glass/10 text-dim hover:bg-glass/[0.16]'
                      }`}
                    >
                      {REASONING_LABEL[lvl]}
                    </button>
                  ))}
                </div>
                <div className="text-xs text-dim mt-2">{REASONING_DESC[reasoning]}</div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm font-medium text-ink">Token capacity</div>
                  <div className="text-xs text-dim tabular-nums">{maxTokens.toLocaleString()} tokens</div>
                </div>
                <input
                  type="range"
                  min={MIN_TOKENS}
                  max={MAX_TOKENS}
                  step={256}
                  value={maxTokens}
                  onChange={(e) => pickTokens(Number(e.target.value))}
                  className="w-full accent-gold cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-dim mt-1">
                  <span>256</span>
                  <span>32k</span>
                </div>
              </div>
              <div className="flex items-center gap-1.5 border-t border-glass/[0.12] pt-3 text-[11px] text-dim">
                <Check size={12} className="text-emerald-400" /> Your reasoning &amp; token settings save automatically and apply to every new answer.
              </div>
            </div>
          </Section>

          {/* Web & streaming */}
          <Section icon={<Globe size={15} />} title="Web &amp; streaming" desc="Live search and how replies appear">
            <div className="rounded-xl border border-glass/[0.18] bg-glass/[0.11] backdrop-blur-2xl divide-y divide-glass/[0.12]">
              <ToggleRow
                icon={<Globe size={16} className="text-dim" />}
                title="Web search"
                desc="Let Nalu search the live web when it helps"
                on={webSearch}
                onToggle={toggleWeb}
              />
              <ToggleRow
                icon={<Zap size={16} className="text-dim" />}
                title="Stream replies"
                desc={streaming ? 'Replies type out live as they generate' : 'Replies appear all at once when ready'}
                on={streaming}
                onToggle={toggleStream}
              />
            </div>
          </Section>

          </div>
          <div className="ws-settings-group" hidden={category !== 'Video & engine'}>
          {/* Video engine — the $0, on-device ladder */}
          <VideoEngineSection />


          {/* Model */}
          <Section icon={<Cpu size={15} />} title="Model" desc="The model behind Nalu">
            <div className="flex items-center gap-3 rounded-xl border border-glass/[0.18] bg-glass/[0.11] backdrop-blur-2xl px-4 py-3.5">
              <div className="w-9 h-9 rounded-lg bg-white/90 flex items-center justify-center shrink-0">
                <img src="/wolf-icon.png" alt="" className="brightness-0 h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-ink">Nalu</div>
                <div className="text-xs text-dim">Nalu's flagship model — long-horizon coding &amp; agents</div>
              </div>
              <span className="rounded-full bg-emerald-500/20 px-2.5 py-1 text-xs font-medium text-emerald-300 shrink-0">
                Active
              </span>
            </div>
          </Section>

          {/* Backend */}
          <Section icon={<Server size={15} />} title="Backend" desc="How replies are generated">
            <div className="rounded-xl border border-glass/[0.18] bg-glass/[0.11] backdrop-blur-2xl px-4 py-3.5 space-y-3">
              <div className="flex items-center gap-2.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                <span className="text-sm text-ink">Connected to the Nalu engine</span>
              </div>
              <div className="flex items-start gap-2 rounded-lg bg-glass/5 px-3 py-2.5 text-xs text-dim">
                <Info size={14} className="mt-0.5 shrink-0 text-dim" />
                <span>Replies are generated by the Nalu engine. If responses fail, your engine endpoint may need attention.</span>
              </div>
            </div>
          </Section>
          </div>

        </div>
      </div>
    </div>
  )
}

// Phone number for the phone-call feature: Nalu can call this number, and an
// inbound call from it is recognized as your account. Saved to your profile.
function PhoneSection() {
  const { user, updateUser } = useAuth()
  const [value, setValue] = useState(user?.phone || '')
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [error, setError] = useState('')
  useEffect(() => { setValue(user?.phone || '') }, [user?.phone])

  const dirty = (value.trim() || '') !== (user?.phone || '')
  const save = async () => {
    setState('saving'); setError('')
    const r = await updateProfile({ phone: value.trim() })
    if (r.ok) { updateUser(r.user); setState('saved'); setTimeout(() => setState('idle'), 1600) }
    else { setState('error'); setError(r.error) }
  }

  if (!user) return null
  return (
    <Section icon={<Phone size={15} />} title="Phone number" desc="So Nalu can call you">
      <div className="rounded-xl border border-glass/[0.18] bg-glass/[0.11] backdrop-blur-2xl px-4 py-3.5 space-y-3">
        <div className="flex items-center gap-2">
          <input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="+1 415 555 1234"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-glass/[0.2] bg-glass/5 px-3 py-2 text-sm text-ink placeholder:text-dim/60 outline-none focus:border-gold/60"
          />
          <button
            onClick={save}
            disabled={!dirty || state === 'saving'}
            className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium bg-gold text-black transition-opacity disabled:opacity-40"
          >
            {state === 'saving' ? 'Saving…' : state === 'saved' ? <><Check size={14} /> Saved</> : 'Save'}
          </button>
        </div>
        {state === 'error'
          ? <div className="text-xs text-red-400">{error}</div>
          : <div className="text-xs text-dim">Include your country code (e.g. +1 for the US). Nalu calls this number when you ask it to, and recognizes you when you call in.</div>}
      </div>
    </Section>
  )
}

function Section({
  icon,
  title,
  desc,
  children,
}: {
  icon: React.ReactNode
  title: string
  desc: string
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-dim">{icon}</span>
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        <span className="text-xs text-dim">· {desc}</span>
      </div>
      {children}
    </section>
  )
}

// Shows which video rung is live on THIS device: the real MiniMax-H3 runner
// (frontier, on-device, $0) when it's up, otherwise the in-browser engine that
// works everywhere, plus a one-command hint to unlock the frontier rung.
function VideoEngineSection() {
  const [h3, setH3] = useState<'checking' | 'on' | 'off'>('checking')
  const canRecord = canRecordOnDevice()
  const gpu = hasWebGPU()
  useEffect(() => {
    let alive = true
    const probe = () => h3Available().then((ok) => { if (alive) setH3(ok ? 'on' : 'off') }).catch(() => alive && setH3('off'))
    probe()
    const id = setInterval(probe, 20_000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  const active = h3 === 'on'
    ? { label: 'MiniMax-H3 · on your device', note: 'Frontier omni-modal video + native stereo audio, running locally. $0.', tone: 'emerald' as const }
    : canRecord
      ? { label: 'On-device engine', note: `Real video + stereo audio, generated in your browser${gpu ? ' (WebGPU accelerated)' : ''}. Works on any device. $0.`, tone: 'emerald' as const }
      : { label: 'Cloud (free pool)', note: 'This browser can’t record locally — using the free cloud video pool.', tone: 'amber' as const }

  return (
    <Section icon={<Clapperboard size={15} />} title="Video engine" desc="How videos are made — free, on your device">
      <div className="rounded-xl border border-glass/[0.18] bg-glass/[0.11] backdrop-blur-2xl px-4 py-3.5 space-y-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-glass/5 flex items-center justify-center shrink-0">
            <Clapperboard size={16} className="text-ink" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink">{active.label}</div>
            <div className="text-xs text-dim">{active.note}</div>
          </div>
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium shrink-0 ${active.tone === 'emerald' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}`}>
            {h3 === 'checking' ? '…' : 'Active'}
          </span>
        </div>
        {!active.label.startsWith('MiniMax-H3') && (
          <div className="rounded-lg border border-glass/[0.14] bg-glass/[0.05] px-3 py-2.5 text-xs text-dim">
            <div className="font-medium text-ink mb-1">Unlock the frontier rung (real MiniMax-H3, 8GB+)</div>
            Run the local runner once and every video upgrades automatically:
            <code className="mt-1 block rounded bg-black/30 px-2 py-1 font-mono text-[11px] text-emerald-200">cd h3-server &amp;&amp; bash setup.sh &amp;&amp; bash run.sh</code>
          </div>
        )}
      </div>
    </Section>
  )
}

function ToggleRow({ icon, title, desc, on, onToggle }: { icon: React.ReactNode; title: string; desc: string; on: boolean; onToggle: () => void }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <div className="w-9 h-9 rounded-lg bg-glass/5 flex items-center justify-center shrink-0">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-ink">{title}</div>
        <div className="text-xs text-dim">{desc}</div>
      </div>
      <button
        onClick={onToggle}
        role="switch"
        aria-checked={on}
        aria-label={title}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition-colors ${on ? 'border-emerald-400 bg-emerald-500' : 'border-glass/30 bg-glass/20'}`}
      >
        {/* inline-flex + a flex-child knob (NOT absolute-without-left) so the knob is
            always correctly positioned inside a clearly-visible track. */}
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-200 ${on ? 'translate-x-[22px]' : 'translate-x-1'}`} />
      </button>
    </div>
  )
}
