import { Component, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'

// Wraps a generated card (CAD / 3D blueprint / deck / doc / design). If it throws
// — a WebGL context loss, a bad geometry, a render error — we show a small inline
// error instead of letting it crash (white-screen) the whole app. A "Retry"
// remounts the child.

type Props = { children: ReactNode; label?: string }
type State = { failed: boolean; key: number }

export default class CardErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, key: 0 }

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true }
  }

  componentDidCatch(err: unknown) {
    // Keep it quiet but logged for debugging; never rethrow.
    // eslint-disable-next-line no-console
    console.warn('[Nalu] card render error:', err)
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="my-2 flex items-center gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3 text-sm text-amber-200">
          <AlertTriangle size={16} className="shrink-0" />
          <span className="flex-1">
            {this.props.label || 'This view'} couldn’t render here.
          </span>
          <button
            onClick={() => this.setState((s) => ({ failed: false, key: s.key + 1 }))}
            className="rounded-lg bg-white/10 px-2.5 py-1 text-xs text-[#ededed] hover:bg-white/20"
          >
            Retry
          </button>
        </div>
      )
    }
    // `key` change forces a fresh mount on retry.
    return <div key={this.state.key}>{this.props.children}</div>
  }
}
