// Nalu Studio kind→card switch. Itself lazy-loaded by Workspace, so the whole
// creative subtree (fabric / jspdf / docx — all dynamically imported inside the
// cards) stays out of the main bundle.
import DesignCard from './DesignCard'
import CanvasCard from './CanvasCard'
import { PaletteCard, BrandCard, BlueprintCard, LogoCard, ShoppingCard } from './StudioCards'
import type { DesignArtifact } from './types'

export default function DesignArtifactCard({ art }: { art: DesignArtifact }) {
  switch (art.kind) {
    case 'webpage':
    case 'poster':
    case 'motion':
      return <DesignCard html={art.html} />
    case 'canvas':
      return <CanvasCard art={art} />
    case 'palette':
      return <PaletteCard art={art} />
    case 'brand':
      // New form: a polished multi-page HTML brand book (rendered live + printable).
      // Legacy structured form falls back to the card.
      return art.html ? <DesignCard html={art.html} /> : <BrandCard art={art} />
    case 'blueprint':
      return <BlueprintCard art={art} />
    case 'logo':
      return <LogoCard art={art} />
    case 'shopping':
      return <ShoppingCard art={art} />
    default:
      return null
  }
}
