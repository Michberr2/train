import { useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Terminal as TerminalIcon, X, Trash2 } from 'lucide-react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'
import { streamShell, type NaluPairing } from '../lib/nalu-client'

interface Props {
  pairing: NaluPairing
  open: boolean
  onClose: () => void
}

const PROMPT = '\x1b[38;2;124;156;255m›\x1b[0m '
// Tighter color palette matching Nalu Dark. Same #7c9cff accent the rest of
// the Dashboard uses; mapped onto xterm's named slots so any ANSI escape from
// the shell renders coherently.
const NALU_THEME = {
  background: '#0c0f14',
  foreground: '#e6e8eb',
  cursor: '#7c9cff',
  cursorAccent: '#0c0f14',
  selectionBackground: '#7c9cff40',
  black: '#0c0f14', brightBlack: '#3a4252',
  red: '#ff7b72', brightRed: '#ff9b95',
  green: '#58e6a3', brightGreen: '#7eeebc',
  yellow: '#ffd479', brightYellow: '#ffdf9d',
  blue: '#7c9cff', brightBlue: '#94aeff',
  magenta: '#d2a8ff', brightMagenta: '#dfc1ff',
  cyan: '#79c0ff', brightCyan: '#a5d6ff',
  white: '#e6e8eb', brightWhite: '#ffffff',
}

export default function NaluTerminalPanel({ pairing, open, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const lineRef = useRef('')
  const historyRef = useRef<string[]>([])
  const historyIdxRef = useRef<number | null>(null)
  const runningRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const [streaming, setStreaming] = useState(false)

  const writePrompt = useCallback(() => {
    const t = termRef.current
    if (!t) return
    t.write(`\r\n${PROMPT}`)
    lineRef.current = ''
  }, [])

  const runCommand = useCallback(async (cmd: string) => {
    const t = termRef.current
    if (!t) return
    runningRef.current = true
    setStreaming(true)
    const controller = new AbortController()
    abortRef.current = controller
    t.write('\r\n')
    try {
      for await (const ev of streamShell(pairing, cmd, { signal: controller.signal })) {
        if (ev.data) t.write(ev.data.replace(/\n/g, '\r\n'))
        if (typeof ev.exit_code === 'number') {
          if (ev.exit_code !== 0) {
            t.write(`\r\n\x1b[31m[exit ${ev.exit_code}]\x1b[0m`)
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        t.write(`\r\n\x1b[31m${(e as Error).message}\x1b[0m`)
      }
    } finally {
      runningRef.current = false
      setStreaming(false)
      abortRef.current = null
      writePrompt()
    }
  }, [pairing, writePrompt])

  // Mount the terminal once when the panel opens.
  useEffect(() => {
    if (!open || !hostRef.current || termRef.current) return
    const term = new Terminal({
      theme: NALU_THEME,
      fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, monospace",
      fontSize: 12,
      lineHeight: 1.4,
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
      allowTransparency: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    term.writeln(
      '\x1b[38;2;124;156;255mNalu shell\x1b[0m — runs via your local Odysseus, line-buffered.',
    )
    term.writeln('\x1b[38;2;91;100;120m(Ctrl+C aborts a running command; ↑/↓ for history)\x1b[0m')
    writePrompt()

    // Line editing — xterm sends keystrokes; we buffer until Enter, then run.
    term.onData((data: string) => {
      const t = termRef.current
      if (!t) return
      // While a command runs, Ctrl+C aborts it (no other input accepted)
      if (runningRef.current) {
        if (data === '') abortRef.current?.abort()
        return
      }
      for (const ch of data) {
        switch (ch) {
          case '\r': {
            const cmd = lineRef.current.trim()
            if (cmd) {
              historyRef.current.push(cmd)
              historyIdxRef.current = null
              runCommand(cmd)
            } else {
              writePrompt()
            }
            return
          }
          case '': // backspace
            if (lineRef.current.length > 0) {
              lineRef.current = lineRef.current.slice(0, -1)
              t.write('\b \b')
            }
            break
          case '':
            // Heuristic: this is the start of an escape sequence; xterm hands
            // ↑/↓ as ESC[A/ESC[B in `data`. We get them as a clump here.
            break
          case '': // Ctrl+C — clear current line
            t.write('^C')
            writePrompt()
            return
          default:
            if (ch >= ' ') {
              lineRef.current += ch
              t.write(ch)
            }
        }
      }
      // History recall: detect arrow-up/down chunks.
      if (data === '[A') {
        const hist = historyRef.current
        if (!hist.length) return
        const next = historyIdxRef.current === null ? hist.length - 1 : Math.max(0, historyIdxRef.current - 1)
        historyIdxRef.current = next
        // Clear current line, write history entry
        for (let i = 0; i < lineRef.current.length; i++) t.write('\b \b')
        lineRef.current = hist[next]
        t.write(lineRef.current)
      } else if (data === '[B') {
        const hist = historyRef.current
        if (historyIdxRef.current === null) return
        const next = Math.min(hist.length - 1, historyIdxRef.current + 1)
        historyIdxRef.current = next === hist.length - 1 && hist.length > 0 ? null : next
        for (let i = 0; i < lineRef.current.length; i++) t.write('\b \b')
        lineRef.current = historyIdxRef.current === null ? '' : hist[next]
        t.write(lineRef.current)
      }
    })

    return () => {
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [open, writePrompt, runCommand])

  // Refit on resize.
  useEffect(() => {
    if (!open) return
    const ro = new ResizeObserver(() => fitRef.current?.fit())
    if (hostRef.current) ro.observe(hostRef.current)
    return () => ro.disconnect()
  }, [open])

  function handleClear() {
    termRef.current?.clear()
    writePrompt()
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button aria-label="Close terminal" onClick={onClose}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 cursor-default bg-black/40 backdrop-blur-sm" />
          <motion.aside
            initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
            transition={{ duration: 0.22, ease: [0.22, 0.61, 0.36, 1] }}
            className="fixed inset-x-0 bottom-0 z-50 flex h-1/2 flex-col border-t border-white/10 bg-[#0c0f14] shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/5 px-4 py-2">
              <div className="flex items-center gap-2 text-foreground">
                <TerminalIcon size={14} />
                <span className="text-xs font-semibold">Nalu shell</span>
                {streaming && <span className="text-[11px] text-amber-400">running…</span>}
              </div>
              <div className="flex items-center gap-1">
                <button onClick={handleClear} className="rounded p-1.5 text-foreground/60 hover:bg-white/5 hover:text-foreground" aria-label="Clear" title="Clear">
                  <Trash2 size={13} />
                </button>
                <button onClick={onClose} className="rounded p-1.5 text-foreground/60 hover:bg-white/5 hover:text-foreground" aria-label="Close" title="Close">
                  <X size={14} />
                </button>
              </div>
            </div>
            <div ref={hostRef} className="flex-1 min-h-0" />
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
