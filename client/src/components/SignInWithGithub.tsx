import { Github } from 'lucide-react'

interface Props {
  /** Where to land after sign-in. Defaults to "/". */
  next?: string
  className?: string
  variant?: 'primary' | 'ghost'
  label?: string
}

/** Anchors to /api/auth/github so the redirect is a full top-level navigation —
 *  required so the browser sends the eventual httpOnly session cookie back. */
export default function SignInWithGithub({
  next = '/',
  className = '',
  variant = 'primary',
  label = 'Sign in with GitHub',
}: Props) {
  const href = `/api/auth/github?next=${encodeURIComponent(next)}`
  const styles =
    variant === 'primary'
      ? 'bg-foreground text-background hover:opacity-90'
      : 'border border-white/10 bg-card/60 text-foreground hover:bg-card/80'
  return (
    <a
      href={href}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors ${styles} ${className}`}
    >
      <Github size={16} />
      {label}
    </a>
  )
}
