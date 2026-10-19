import { createContext, useContext } from 'react'

/** Scoped Swarm previews never invoke ordinary generation, public publication,
 * or global brand writes. Existing Studio cards keep their normal defaults. */
export const ScopedArtifactContext = createContext(false)
export const useScopedArtifact = () => useContext(ScopedArtifactContext)
