import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from 'react'
import * as localAuth from '../lib/localAuth'
import { installSync, loadFromServer, clearLocal } from '../lib/sync'
import AuthModal from './AuthModal'

type Mode = 'signin' | 'signup'

interface AuthContextType {
  user: localAuth.PublicUser | null
  signOut: () => void
  openAuth: (mode?: Mode) => void
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  signOut: () => {},
  openAuth: () => {},
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

  useEffect(() => {
    installSync()
    localAuth.currentUser().then(async (u) => {
      if (u) await loadFromServer()
      setUser(u)
    })
  }, [])

  const openAuth = useCallback((m: Mode = 'signin') => {
    setMode(m)
    setModalOpen(true)
  }, [])

  const closeAuth = useCallback(() => setModalOpen(false), [])

  const signOut = useCallback(() => {
    void localAuth.signOut()
    clearLocal()
    setUser(null)
  }, [])

  const handleAuthed = useCallback(
    async (u: localAuth.PublicUser) => {
      clearLocal()
      await loadFromServer()
      setUser(u)
      setModalOpen(false)
    },
    []
  )

  return (
    <AuthContext.Provider value={{ user, signOut, openAuth }}>
      {children}
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
