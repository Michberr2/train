import { lazy, Suspense } from 'react'
import LoadingScreen from './components/LoadingScreen'
import LandingPage from './components/landing/LandingPage'
import { useAuth } from './components/AuthProvider'

const Workspace = lazy(() => import('./components/workspace/design/DesignedWorkspace'))

export default function App() {
  const { user, signOut } = useAuth()

  // Keep the authenticated workspace and account lifecycle separate from the public story.
  if (user) {
    return <Suspense fallback={<LoadingScreen />}><Workspace key={user.id} user={user} onLogout={signOut} /></Suspense>
  }
  return <LandingPage />
}
