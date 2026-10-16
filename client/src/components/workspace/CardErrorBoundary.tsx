import { Component, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'

// Wraps a generated card (CAD / 3D blueprint / deck / doc / design). If it throws
// — a WebGL context loss, a bad geometry, a render error — we show a small inline
// error instead of letting it crash (white-screen) the whole app. A "Retry"
// remounts the child.

type Props = { children: ReactNode; label?: string; previewHtml?: string; resetKey?: unknown }
type State = { failed: boolean; key: number; reload: boolean }

export default class CardErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, key: 0, reload: false }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    const message = error instanceof Error ? error.message : String(error)
    return { failed: true, reload: /dynamically imported module|importing a module script|loading chunk|chunkloaderror|module script.*failed/i.test(message) }
  }

  componentDidUpdate(previous: Props) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState(s => ({ failed: false, key: s.key + 1, reload: false }))
  }

  componentDidCatch(err: unknown) {
    // Keep it quiet but logged for debugging; never rethrow.
    // eslint-disable-next-line no-console
    console.warn('[Nalu] card render error:', err)
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="my-2">
        <div role="alert" className="flex items-center gap-3 rounded-xl border border-amber-600/30 bg-panel/80 px-4 py-3 text-sm text-ink">
          <AlertTriangle size={16} className="shrink-0" />
          <span className="flex-1">
            {this.props.previewHtml ? 'The preview controls couldn’t load. Your saved design is shown below.' : `${this.props.label || 'This view'} couldn’t load. Your saved work is still here.`}
          </span>
          <button
            onClick={() => this.state.reload ? window.location.reload() : this.setState((s) => ({ failed: false, key: s.key + 1 }))}
            className="rounded-lg bg-glass/10 px-2.5 py-1 text-xs text-ink hover:bg-glass/20"
          >
            {this.state.reload ? 'Reload preview' : 'Retry'}
          </button>
        </div>
        {typeof this.props.previewHtml === 'string' && this.props.previewHtml && <iframe title="Saved design preview" srcDoc={this.props.previewHtml} sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads" className="mt-3 h-[70vh] w-full rounded-xl border border-glass/20 bg-white" />}
        </div>
      )
    }
    // `key` change forces a fresh mount on retry.
    return <div key={this.state.key}>{this.props.children}</div>
  }
}
