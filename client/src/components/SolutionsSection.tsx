import { useState } from 'react'
import { motion } from 'framer-motion'
import UltraThinkDemo from './UltraThinkDemo'

export default function SolutionsSection() {
  const [activeTab, setActiveTab] = useState('methods')

  const tabs = [
    { key: 'methods', label: 'Build' },
    { key: 'advice', label: 'Guide' },
    { key: 'reliability', label: 'Test' },
    { key: 'reward', label: 'Connect' },
  ] as const

  const subtitleByTab: Record<string, string> = {
    methods: 'Train your own LLM in clicks, not papers.',
    advice: 'Built for people who know nothing about AI.',
    reliability: 'Outperforms every closed model on the public benchmarks.',
    reward: 'Plug into any local IDE or coding agent.',
  }

  return (
    <div className="relative h-screen w-full flex flex-col">
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: 'url(/images/bg-beach-rocks.png)' }}
      />

      <div className="h-28 md:h-32 flex-shrink-0" />

      <div className="relative z-10 flex-1 flex flex-col items-center md:justify-center w-full max-w-5xl mx-auto px-4 sm:px-6 pb-8 overflow-y-auto scrollbar-hide">
        <h1 className="text-3xl md:text-4xl lg:text-5xl font-light text-white mb-8 md:mb-12 tracking-tight text-center drop-shadow-lg">
          An AI that builds AI. Free to use. Yours to keep.
        </h1>

        <div className="w-full max-w-4xl bg-white/90 dark:bg-white/95 backdrop-blur-xl rounded-2xl p-6 md:p-10 shadow-xl">
          <div
            className="flex justify-center gap-0.5 mb-8 flex-wrap"
            role="tablist"
            aria-label="Solutions categories"
          >
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                role="tab"
                aria-selected={activeTab === t.key}
                aria-controls={`panel-${t.key}`}
                className={`relative px-5 py-3 min-h-[44px] text-base md:text-lg transition-colors rounded-xl ${
                  activeTab === t.key
                    ? 'text-gray-900 font-normal'
                    : 'text-gray-400 hover:text-gray-900 font-light'
                }`}
              >
                {t.label}
                {activeTab === t.key && (
                  <motion.div
                    className="absolute bottom-0.5 left-3 right-3 h-[2px] bg-blue-500 rounded-full"
                    layoutId="solutions-tab-indicator"
                    transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                  />
                )}
              </button>
            ))}
          </div>

          <div
            id={`panel-${activeTab}`}
            role="tabpanel"
            className="space-y-6"
          >
            <p className="text-base md:text-lg text-gray-500 leading-relaxed text-center max-w-xl mx-auto font-light">
              {subtitleByTab[activeTab]}
            </p>
            <UltraThinkDemo type={activeTab as 'methods' | 'advice' | 'reliability' | 'reward'} />
          </div>
        </div>
      </div>
    </div>
  )
}
