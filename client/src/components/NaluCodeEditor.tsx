import { useEffect, useRef } from 'react'
import Editor, { type OnMount, type Monaco } from '@monaco-editor/react'

interface Props {
  value: string
  onChange?: (next: string) => void
  language?: string
  /** "nalu-dark" by default — matches the Codex Dashboard look. */
  theme?: 'nalu-dark' | 'vs-dark' | 'light'
  readOnly?: boolean
  /** Cmd/Ctrl+S handler — Monaco swallows the keystroke; route it to the caller. */
  onSave?: () => void
  className?: string
}

// Color palette mirrors NaluCodeEditor's accents in the rest of the Dashboard
// (the same #7c9cff used by the Pair pill / accent button). Kept in sync with
// extensions/theme-defaults/themes/nalu-dark.json in the nalu-ide fork.
function defineNaluTheme(monaco: Monaco): void {
  monaco.editor.defineTheme('nalu-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '5b6478', fontStyle: 'italic' },
      { token: 'string', foreground: 'a5d6ff' },
      { token: 'number', foreground: 'ffa657' },
      { token: 'keyword', foreground: 'd2a8ff' },
      { token: 'type', foreground: '79c0ff' },
      { token: 'function', foreground: '7c9cff' },
      { token: 'variable', foreground: 'e6e8eb' },
      { token: 'tag', foreground: '7c9cff' },
      { token: 'attribute.name', foreground: '7ee787' },
    ],
    colors: {
      'editor.background': '#0c0f14',
      'editor.foreground': '#e6e8eb',
      'editor.lineHighlightBackground': '#141823',
      'editor.selectionBackground': '#7c9cff40',
      'editor.inactiveSelectionBackground': '#7c9cff20',
      'editor.findMatchBackground': '#7c9cff50',
      'editor.findMatchHighlightBackground': '#7c9cff30',
      'editorCursor.foreground': '#7c9cff',
      'editorLineNumber.foreground': '#3a4252',
      'editorLineNumber.activeForeground': '#a8b1c1',
      'editorIndentGuide.background1': '#1c2230',
      'editorIndentGuide.activeBackground1': '#2c3445',
      'editorWidget.background': '#0f131b',
      'editorWidget.border': '#1c2230',
      'editorSuggestWidget.background': '#0f131b',
      'editorSuggestWidget.border': '#1c2230',
      'editorSuggestWidget.selectedBackground': '#7c9cff15',
      'scrollbarSlider.background': '#1c223080',
      'scrollbarSlider.hoverBackground': '#252e3f80',
      'scrollbarSlider.activeBackground': '#7c9cff60',
    },
  })
}

/** Best-effort language guess from a filename. Monaco autoloads workers for
 *  these. Unknown extensions fall back to plaintext. */
export function languageFromFilename(name: string | null | undefined): string {
  if (!name) return 'plaintext'
  const ext = name.toLowerCase().split('.').pop() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    mjs: 'javascript', cjs: 'javascript',
    json: 'json', md: 'markdown', html: 'html', css: 'css', scss: 'scss',
    py: 'python', rs: 'rust', go: 'go', rb: 'ruby', php: 'php', java: 'java',
    kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
    cs: 'csharp', sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
    yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', sql: 'sql',
    xml: 'xml', svg: 'xml', dockerfile: 'dockerfile',
  }
  return map[ext] || 'plaintext'
}

export default function NaluCodeEditor({
  value, onChange, language, theme = 'nalu-dark', readOnly = false,
  onSave, className,
}: Props) {
  const monacoRef = useRef<Monaco | null>(null)

  const handleMount: OnMount = (editor, monaco) => {
    monacoRef.current = monaco
    defineNaluTheme(monaco)
    monaco.editor.setTheme(theme)
    if (onSave) {
      // Monaco's own Save command (Cmd/Ctrl+S) doesn't fire host-level events;
      // bind it directly so callers can flush their persistence layer.
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
        () => onSave(),
      )
    }
  }

  // If theme prop changes after mount, re-apply.
  useEffect(() => {
    if (monacoRef.current) {
      defineNaluTheme(monacoRef.current)
      monacoRef.current.editor.setTheme(theme)
    }
  }, [theme])

  return (
    <Editor
      className={className}
      value={value}
      language={language ?? 'plaintext'}
      theme={theme}
      onChange={(v) => onChange?.(v ?? '')}
      onMount={handleMount}
      loading={<div className="flex items-center justify-center h-full text-xs text-foreground/50">Loading editor…</div>}
      options={{
        readOnly,
        fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, monospace",
        fontSize: 13,
        lineHeight: 1.55,
        letterSpacing: 0.2,
        cursorBlinking: 'smooth',
        cursorSmoothCaretAnimation: 'on',
        renderLineHighlight: 'gutter',
        renderWhitespace: 'selection',
        minimap: { enabled: false },
        glyphMargin: false,
        folding: true,
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        smoothScrolling: true,
        bracketPairColorization: { enabled: true },
        guides: { bracketPairs: 'active', indentation: true },
        padding: { top: 16, bottom: 16 },
        stickyScroll: { enabled: false },
        automaticLayout: true,
        wordWrap: 'on',
      }}
    />
  )
}
