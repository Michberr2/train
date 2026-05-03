import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { TrendingUp, Shield, Zap } from 'lucide-react'

const fadeInUp = {
  initial: { opacity: 0, y: 20, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
}

const staggerContainer = {
  initial: {},
  animate: { transition: { staggerChildren: 0.06, delayChildren: 0.15 } },
}

const books = [
  { title: 'Deep Learning', author: 'Goodfellow, Bengio, Courville', readTime: '~25 hours' },
  { title: 'Pattern Recognition and Machine Learning', author: 'Christopher Bishop', readTime: '~22 hours' },
  { title: 'The Elements of Statistical Learning', author: 'Hastie, Tibshirani, Friedman', readTime: '~20 hours' },
  { title: 'Reinforcement Learning: An Introduction', author: 'Sutton & Barto', readTime: '~18 hours' },
  { title: 'Hands-On Machine Learning', author: 'Aurélien Géron', readTime: '~14 hours' },
  { title: 'AI Engineering', author: 'Chip Huyen', readTime: '~10 hours' },
]

const aboutCards = [
  {
    title: 'Who We Are',
    body: "Nalu is an AI that runs on your screen and works for you. It cleans your inbox, finishes your homework, books your trips. When you want, it helps you build your own AI from the same machine.",
  },
  {
    title: 'What We Believe',
    body: "Software should do work, not just suggest it. The next AI shouldn't live in a chat window. It should take the wheel, finish the job, and hand you back your day. And the AI you build with it should be yours.",
  },
  {
    title: 'Our Promise',
    body: 'Free in the browser: ask, generate, draft, prototype. Pay once for the desktop app and Nalu drives your full screen, runs your tasks, and trains AI that\'s yours forever.',
  },
]

export default function LearnSection() {
  const [activeTab, setActiveTab] = useState('company')

  const tabs = [
    { key: 'company', label: 'Our Company' },
    { key: 'documentation', label: 'Documentation' },
    { key: 'about', label: 'About Us' },
  ]

  return (
    <div className="relative h-screen w-full flex flex-col">
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: 'url(/images/bg-sandy-beach.png)' }}
      />

      <div className="h-28 md:h-32 flex-shrink-0" />

      <div className="relative z-10 flex-1 flex flex-col items-center md:justify-center w-full max-w-5xl mx-auto px-4 sm:px-6 pb-8 overflow-y-auto scrollbar-hide">
        <motion.div
          className="text-center mb-8 md:mb-12"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.25, 0.46, 0.45, 0.94] }}
        >
          <h1 className="text-3xl md:text-4xl lg:text-5xl font-light text-white mb-2 tracking-tight drop-shadow-lg">
            Learn about Nalu
          </h1>
          <p className="text-sm text-white/80 font-light drop-shadow">An AI that helps anyone build AI</p>
        </motion.div>

        <div className="w-full max-w-4xl bg-white/90 dark:bg-white/95 backdrop-blur-xl rounded-2xl p-6 md:p-10 shadow-xl flex-shrink-0">
          <div className="flex justify-center gap-0.5 mb-8 flex-wrap" role="tablist" aria-label="Learn categories">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                role="tab"
                aria-selected={activeTab === tab.key}
                aria-controls={`panel-${tab.key}`}
                className={`relative px-5 py-3 min-h-[44px] text-base md:text-lg transition-colors rounded-xl ${
                  activeTab === tab.key
                    ? 'text-gray-900 font-normal'
                    : 'text-gray-400 hover:text-gray-900 font-light'
                }`}
              >
                {tab.label}
                {activeTab === tab.key && (
                  <motion.div
                    className="absolute bottom-0.5 left-3 right-3 h-[2px] bg-blue-500 rounded-full"
                    layoutId="tab-indicator"
                    transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                  />
                )}
              </button>
            ))}
          </div>

          <AnimatePresence mode="wait">
            {activeTab === 'company' && (
              <motion.div
                key="company"
                id="panel-company"
                role="tabpanel"
                className="space-y-6"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
              >
                <p className="text-base md:text-lg text-gray-500 leading-relaxed text-center max-w-2xl mx-auto font-light">
                  Nalu is the AI that helps you build AI. Free in the browser, powerful on the desktop, designed for people with no ML background.
                </p>

                <motion.div
                  className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-3xl mx-auto"
                  variants={staggerContainer}
                  initial="initial"
                  animate="animate"
                >
                  {[
                    {
                      Icon: TrendingUp,
                      title: 'Build Your Own AI',
                      body: 'From idea to working model in minutes. Nalu picks the model, drafts the prompts, and runs the evals so you can focus on what you want it to do.',
                    },
                    {
                      Icon: Shield,
                      title: 'For Everyone',
                      body: 'Built for people who have never written a line of ML code. Plain-English instructions, sensible defaults, and zero jargon between you and a working model.',
                    },
                    {
                      Icon: Zap,
                      title: 'Top of Every Benchmark',
                      body: 'Nalu tests better than every major closed model on the public reasoning, coding, and instruction-following benchmarks, with reproducible scripts.',
                    },
                  ].map(({ Icon, title, body }) => (
                    <motion.div
                      key={title}
                      variants={fadeInUp}
                      transition={{ duration: 0.45, ease: [0.25, 0.46, 0.45, 0.94] }}
                      whileHover={{ y: -3, boxShadow: '0 12px 32px rgba(0,0,0,0.06)' }}
                      className="bg-white rounded-2xl p-6 shadow-sm border border-gray-200/60 text-center"
                    >
                      <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center mx-auto mb-3">
                        <Icon className="w-5 h-5 text-blue-500" />
                      </div>
                      <h3 className="text-sm font-medium text-gray-900 mb-2 tracking-tight">{title}</h3>
                      <p className="text-xs text-gray-500 leading-relaxed font-light">{body}</p>
                    </motion.div>
                  ))}
                </motion.div>
              </motion.div>
            )}

            {activeTab === 'documentation' && (
              <motion.div
                key="documentation"
                id="panel-documentation"
                role="tabpanel"
                className="space-y-6 max-w-2xl mx-auto"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
              >
                <p className="text-sm md:text-base text-gray-400 leading-relaxed text-center font-light">
                  Foundational reading that shaped how Nalu helps anyone build AI.
                </p>

                <motion.div
                  className="grid grid-cols-1 sm:grid-cols-2 gap-3.5"
                  variants={staggerContainer}
                  initial="initial"
                  animate="animate"
                >
                  {books.map((book) => (
                    <motion.div
                      key={book.title}
                      variants={fadeInUp}
                      transition={{ duration: 0.45, ease: [0.25, 0.46, 0.45, 0.94] }}
                      whileHover={{ y: -2, boxShadow: '0 8px 24px rgba(0,0,0,0.05)' }}
                      className="group bg-white rounded-2xl p-5 shadow-sm transition-all duration-200 flex gap-4 items-start border border-gray-200/60"
                    >
                      <div className="w-[3px] min-h-[48px] self-stretch rounded-full flex-shrink-0 bg-gradient-to-b from-blue-500 to-blue-300" />
                      <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-medium text-gray-900 mb-1 group-hover:text-blue-500 transition-colors tracking-tight">
                          {book.title}
                        </h3>
                        <p className="text-xs text-gray-500 mb-1.5 font-light">{book.author}</p>
                        <p className="text-[11px] text-gray-400 font-light tracking-wide">{book.readTime}</p>
                      </div>
                    </motion.div>
                  ))}
                </motion.div>
              </motion.div>
            )}

            {activeTab === 'about' && (
              <motion.div
                key="about"
                id="panel-about"
                role="tabpanel"
                className="space-y-6 max-w-3xl mx-auto"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
              >
                <p className="text-base md:text-lg text-gray-500 leading-relaxed text-center max-w-xl mx-auto font-light">
                  Our mission is simple: put the power to build AI in the hands of anyone with an idea, not just researchers.
                </p>

                <motion.div
                  className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-5"
                  variants={staggerContainer}
                  initial="initial"
                  animate="animate"
                >
                  {aboutCards.map((card) => (
                    <motion.div
                      key={card.title}
                      variants={fadeInUp}
                      transition={{ duration: 0.45, ease: [0.25, 0.46, 0.45, 0.94] }}
                      whileHover={{ y: -3, boxShadow: '0 12px 32px rgba(0,0,0,0.06)' }}
                      className="bg-white rounded-2xl p-6 shadow-sm border border-gray-200/60 text-center"
                    >
                      <h3 className="text-sm font-medium text-gray-900 mb-3 tracking-tight">{card.title}</h3>
                      <p className="text-xs text-gray-500 leading-relaxed font-light">{card.body}</p>
                    </motion.div>
                  ))}
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
