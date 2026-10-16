import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
} from 'react'
import * as localAuth from '../lib/localAuth'
import { installSync, loadFromServer, clearLocal, prepareAccount } from '../lib/sync'
import AuthModal from './AuthModal'

type Mode = 'signin' | 'signup'

interface AuthContextType {
  user: localAuth.PublicUser | null
  signOut: () => void
  openAuth: (mode?: Mode) => void
  updateUser: (u: localAuth.PublicUser) => void
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  signOut: () => {},
  openAuth: () => {},
  updateUser: () => {},
})

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  return useContext(AuthContext)
}

/**
 * Client-side auth state for the whole app. Reads the persisted session on
 * mount, exposes sign-out + a way to open the sign-in/up modal, and renders a
 * single shared <AuthModal> so any component (hero, navbar) can trigger it.
 */
export default function AuthProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [user, setUser] = useState<localAuth.PublicUser | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('signin')
  const revision = useRef(0)
  const [restoreError, setRestoreError] = useState(false)
  const [restoreAttempt, setRestoreAttempt] = useState(0)

  useEffect(() => {
    installSync()
    const restore = async () => {
      setRestoreError(false)
      const attempt = ++revision.current
      const token = localAuth.getToken()
      const current = () => attempt === revision.current && token === localAuth.getToken()
      const u = await localAuth.currentUser()
      if (!current()) return
      if (u) {
        const prepared = await prepareAccount(u.id)
        if (!current()) return
        if (!prepared) { setRestoreError(true); return }
        await loadFromServer()
      }
      if (!current()) return
      setUser(u)
    }
    void restore()
    const onStorage = (event: StorageEvent) => {
      if (event.key !== 'nalu-token' && event.key !== null) return
      // Storage events can queue behind a newer change in another tab.
      if (event.key === 'nalu-token' && event.newValue !== localAuth.getToken()) return
      const attempt = ++revision.current
      setUser(null)
      // Another tab may already have hydrated the new owner. Let restore compare
      // ownership before clearing, so a late event cannot erase its fresh cache.
      if (localAuth.getToken()) void restore()
      else void clearLocal().then(() => { if (attempt === revision.current) void restore() })
    }
    window.addEventListener('storage', onStorage)
    return () => { revision.current++; window.removeEventListener('storage', onStorage) }
  }, [restoreAttempt])

  const openAuth = useCallback((m: Mode = 'signin') => {
    setMode(m)
    setModalOpen(true)
  }, [])

  const closeAuth = useCallback(() => setModalOpen(false), [])

  const signOut = useCallback(() => {
    revision.current++
    void localAuth.signOut()
    void clearLocal()
    setUser(null)
    setModalOpen(false)
    setRestoreError(false)
  }, [])

  const handleAuthed = useCallback(
    async (u: localAuth.PublicUser) => {
      const attempt = ++revision.current
      const token = localAuth.getToken()
      if (!token) return
      const current = () => attempt === revision.current && token === localAuth.getToken()
      setUser(null)
      setRestoreError(false)
      const prepared = await prepareAccount(u.id)
      if (!current()) return
      if (!prepared) { setRestoreError(true); setModalOpen(false); return }
      await loadFromServer()
      if (!current()) return
      setUser(u)
      setModalOpen(false)
    },
    []
  )

  const updateUser = useCallback((u: localAuth.PublicUser) => {
    setUser(previous => previous?.id === u.id && localAuth.getToken() ? u : previous)
  }, [])

  return (
    <AuthContext.Provider value={{ user, signOut, openAuth, updateUser }}>
      {children}
      {restoreError && <div role="alert" className="fixed bottom-4 left-1/2 z-[110] w-[min(92vw,32rem)] -translate-x-1/2 rounded-xl border border-border-gray bg-surface p-4 text-sm text-primary shadow-lg">
        <p>We couldn’t safely open this browser’s saved data. Your existing data has been kept.</p>
        <button className="mt-2 font-medium underline" onClick={() => setRestoreAttempt(value => value + 1)}>Retry opening saved data</button>
      </div>}
      <AuthModal
        open={modalOpen}
        mode={mode}
        setMode={setMode}
        onClose={closeAuth}
        onAuthed={handleAuthed}
      />
    </AuthContext.Provider>
  )
}
