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
} from 'lucide-react'
import { useState } from 'react'
import { useTheme } from '../ThemeProvider'
import {
  REASONING_LEVELS,
  REASONING_DESC,
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
  const [{ reasoning, maxTokens }, setSettings] = useState(getModelSettings())
  const pickReasoning = (r: ReasoningLevel) => setSettings(setModelSettings({ reasoning: r }))
  const pickTokens = (t: number) => setSettings(setModelSettings({ maxTokens: t }))

  return (
    <div className="flex h-full flex-col bg-glass/[0.09] backdrop-blur-2xl text-ink font-sans">
      {/* Header */}
      <header className="flex items-center gap-3 px-6 py-5 border-b border-glass/[0.18] shrink-0">
        <div className="w-9 h-9 rounded-xl bg-glass/10 flex items-center justify-center">
          <Settings size={18} className="text-ink" />
        </div>
        <div className="min-w-0">
          <h1 className="text-base font-semibold tracking-tight leading-tight">Settings</h1>
          <p className="text-xs text-dim">Manage your account, model, and connection</p>
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-6 space-y-8">
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

          {/* Reasoning & capacity */}
          <Section icon={<Gauge size={15} />} title="Reasoning &amp; capacity" desc="How hard Nalu thinks + answer length">
            <div className="rounded-xl border border-glass/[0.18] bg-glass/[0.11] backdrop-blur-2xl px-4 py-3.5 space-y-4">
              <div>
                <div className="text-sm font-medium text-ink mb-2">Reasoning level</div>
                <div className="grid grid-cols-4 gap-1.5">
                  {REASONING_LEVELS.map((lvl) => (
                    <button
                      key={lvl}
                      onClick={() => pickReasoning(lvl)}
                      className={`rounded-lg px-2 py-2 text-xs font-medium capitalize transition-colors ${
                        reasoning === lvl ? 'bg-gold text-black' : 'bg-glass/10 text-dim hover:bg-glass/[0.16]'
                      }`}
                    >
                      {lvl}
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
