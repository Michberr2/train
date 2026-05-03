import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Sun, Moon, MousePointer2 } from 'lucide-react'
import { useTheme } from './ThemeProvider'

interface NavBarProps {
  activeIndex: number
  setActiveIndex: (index: number) => void
  onControlScreen?: () => void
  controlActive?: boolean
}

const navItems = [
  { name: 'meet nalu', href: '#meet' },
  { name: 'platform', href: '#platform' },
  { name: 'solutions', href: '#solutions' },
  { name: 'pricing', href: '#pricing' },
  { name: 'learn', href: '#learn' },
]

export default function NavBar({ activeIndex, setActiveIndex, onControlScreen, controlActive }: NavBarProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const { isDark, toggleTheme } = useTheme()

  const handleNavClick = (index: number) => {
    setActiveIndex(index)
    setMobileMenuOpen(false)
  }

  return (
    <motion.nav
      className="flex items-center justify-between py-4 mb-16 lg:mb-24 relative"
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      aria-label="Main navigation"
    >
      <div className="flex items-center">
        <img
          src="/nalu-logo.png"
          alt="Nalu Logo"
          width={120}
          height={40}
          className="object-contain"
        />
      </div>

      <motion.div
        className="hidden md:block bg-border-gray/60 rounded-xl p-1 border border-border-gray"
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2, duration: 0.5 }}
        role="tablist"
        aria-label="Page sections"
      >
        <div className="flex items-center gap-1">
          {navItems.map((item, index) => (
            <button
              key={item.name}
              onClick={() => handleNavClick(index)}
              role="tab"
              data-nav-index={index}
              aria-selected={activeIndex === index}
              className={`px-4 py-2.5 text-sm rounded-lg min-h-[44px] transition-all duration-200 whitespace-nowrap ${
                activeIndex === index
                  ? 'bg-surface text-primary font-medium shadow-sm'
                  : 'text-nav-text hover:text-primary'
              }`}
            >
              {item.name}
            </button>
          ))}
        </div>
      </motion.div>

      <div className="flex items-center gap-2">
        {onControlScreen && (
          <motion.button
            onClick={onControlScreen}
            disabled={controlActive}
            data-control-trigger="true"
            whileHover={{ scale: controlActive ? 1 : 1.04 }}
            whileTap={{ scale: controlActive ? 1 : 0.96 }}
            aria-label="Demo: let Nalu control the screen"
            className="hidden sm:inline-flex items-center gap-1.5 h-11 px-3.5 rounded-lg bg-primary text-surface text-xs font-medium shadow-sm hover:shadow-md transition-shadow disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <MousePointer2 size={14} className="rotate-[-12deg]" fill="currentColor" strokeWidth={1.4} />
            Control Screen
          </motion.button>
        )}

        <button
          onClick={(e) => toggleTheme(e)}
          aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          className="flex items-center justify-center w-11 h-11 rounded-lg bg-border-gray/60 border border-border-gray text-primary hover:bg-border-gray transition-colors"
        >
          {isDark ? <Sun size={18} strokeWidth={1.5} /> : <Moon size={18} strokeWidth={1.5} />}
        </button>

        <button
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="md:hidden flex items-center justify-center w-11 h-11 rounded-lg bg-border-gray/60 border border-border-gray"
          aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={mobileMenuOpen}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="text-primary">
            {mobileMenuOpen ? (
              <path d="M5 5L15 15M15 5L5 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            ) : (
              <path d="M3 6H17M3 10H17M3 14H17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            )}
          </svg>
        </button>

        <AnimatePresence>
          {mobileMenuOpen && (
            <motion.div
              className="absolute top-full left-0 right-0 mt-2 md:hidden bg-surface rounded-xl border border-border-gray shadow-lg z-50 overflow-hidden"
              initial={{ opacity: 0, y: -8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.98 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              role="menu"
              aria-label="Mobile navigation"
            >
              <div className="flex flex-col p-2">
                {navItems.map((item, index) => (
                  <button
                    key={item.name}
                    onClick={() => handleNavClick(index)}
                    role="menuitem"
                    className={`w-full text-left px-4 py-3 min-h-[44px] text-sm rounded-lg transition-all duration-200 ${
                      activeIndex === index
                        ? 'bg-background text-primary font-medium'
                        : 'text-nav-text hover:text-primary hover:bg-background/50'
                    }`}
                  >
                    {item.name}
                  </button>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.nav>
  )
}
