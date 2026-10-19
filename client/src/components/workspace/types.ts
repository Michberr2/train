// Shared Nalu Studio artifact contract. One discriminated union so Workspace,
// the kind→card router, and the cards all agree on the shape /api/design returns.
import type { CanvasArtifact } from './CanvasCard'
import type { PaletteArt, BrandArt, BlueprintArt, LogoArt, ShoppingArt } from './StudioCards'
import type { WebsiteBehaviorContract } from '../../../../shared/websiteBehavior'

export type DesignKind = 'webpage' | 'poster' | 'canvas' | 'palette' | 'brand' | 'blueprint' | 'logo' | 'shopping' | 'motion' | 'game' | 'board' | 'carousel'

// webpage + poster + motion + game + board are self-contained-HTML artifacts
// (DesignCard). motion is a looping animated "HyperFrame"; game is a playable
// PlayCanvas game; board is a photo-breakdown executive presentation board.
export type WebsiteQuality = { behaviorContract?: WebsiteBehaviorContract; runtime?: {
  status: 'passed' | 'partial' | 'failed' | 'unavailable'
  widths: number[]
  checks: { name: string; width: number; passed: boolean; detail?: string }[]
  limitations: string[]
} }
export type WebpageArt = { kind: 'webpage' | 'poster' | 'motion' | 'game' | 'board'; html: string; name?: string; truncated?: boolean; quality?: WebsiteQuality; motion?: import('./motionFrame').MotionSpec }
export type CarouselSlide = { kind: 'cover' | 'point' | 'cta'; badge?: string; headline: string; sub?: string; body?: string[]; img?: string }
export type CarouselArt = {
  kind: 'carousel'; name?: string; platform?: string; ratio?: string; handle?: string
  theme: { bg: string; bg2: string; ink: string; accent: string; headingFont: string; bodyFont: string }
  slides: CarouselSlide[]; caption?: string; hashtags?: string[]
}

export type DesignArtifact = WebpageArt | CanvasArtifact | PaletteArt | BrandArt | BlueprintArt | LogoArt | ShoppingArt | CarouselArt
