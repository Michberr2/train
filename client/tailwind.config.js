/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'rgb(var(--color-background) / <alpha-value>)',
        surface: 'rgb(var(--color-surface) / <alpha-value>)',
        primary: 'rgb(var(--color-primary) / <alpha-value>)',
        secondary: 'rgb(var(--color-secondary) / <alpha-value>)',
        tertiary: 'rgb(var(--color-tertiary) / <alpha-value>)',
        'nav-text': 'rgb(var(--color-nav-text) / <alpha-value>)',
        'accent-blue': 'rgb(var(--color-accent-blue) / <alpha-value>)',
        'border-gray': 'rgb(var(--color-border-gray) / <alpha-value>)',
        'curve-line': 'rgb(var(--color-curve-line) / <alpha-value>)',
        // Workspace (n4lu.ai app) theme tokens. `glass` flips white-alpha
        // overlays to warm-dark-alpha in light mode; the rest are warm-earthy
        // in light and the original dark values in dark. See globals.css.
        glass: 'rgb(var(--ws-glass) / <alpha-value>)',
        ink: 'rgb(var(--ws-ink) / <alpha-value>)',
        dim: 'rgb(var(--ws-dim) / <alpha-value>)',
        canvas: 'rgb(var(--ws-canvas) / <alpha-value>)',
        panel: 'rgb(var(--ws-panel) / <alpha-value>)',
        panel2: 'rgb(var(--ws-panel2) / <alpha-value>)',
        sidebar: 'rgb(var(--ws-sidebar) / <alpha-value>)',
        accent: 'rgb(var(--ws-accent) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'sans-serif'],
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
      },
      animation: { fadeIn: 'fadeIn 0.5s ease-out' },
      boxShadow: {
        glass: '0 4px 24px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
        'glass-lg': '0 8px 40px rgba(0,0,0,0.08), 0 2px 4px rgba(0,0,0,0.04)',
      },
      borderRadius: { pill: '64px' },
    },
  },
  plugins: [],
}
