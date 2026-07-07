// Nalu Studio kind→card switch. Itself lazy-loaded by Workspace, so the whole
// creative subtree (fabric / jspdf / docx — all dynamically imported inside the
// cards) stays out of the main bundle.
import DesignCard from './DesignCard'
import CarouselCard from './CarouselCard'
import CanvasCard from './CanvasCard'
import { PaletteCard, BrandCard, BlueprintCard, LogoCard, ShoppingCard } from './StudioCards'
import type { DesignArtifact } from './types'

export default function DesignArtifactCard({ art, onUpdate }: { art: DesignArtifact; onUpdate?: (art: DesignArtifact) => void }) {
  switch (art.kind) {
    case 'webpage':
    case 'poster':
    case 'motion':
    case 'game':
    case 'board':
      return (
        <DesignCard
          html={art.html}
          truncated={art.truncated}
          onUpdate={onUpdate ? (html) => onUpdate({ ...art, html, truncated: false }) : undefined}
        />
      )
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
    case 'carousel':
      return <CarouselCard art={art} />
    default:
      return null
  }
}
