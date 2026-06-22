// Shared Nalu Studio artifact contract. One discriminated union so Workspace,
// the kind→card router, and the cards all agree on the shape /api/design returns.
import type { CanvasArtifact } from './CanvasCard'
import type { PaletteArt, BrandArt, BlueprintArt, LogoArt, ShoppingArt } from './StudioCards'

export type DesignKind = 'webpage' | 'poster' | 'canvas' | 'palette' | 'brand' | 'blueprint' | 'logo' | 'shopping' | 'motion'

// webpage + poster + motion are self-contained-HTML artifacts (DesignCard).
// motion is a looping animated "HyperFrame".
export type WebpageArt = { kind: 'webpage' | 'poster' | 'motion'; html: string; name?: string }

export type DesignArtifact = WebpageArt | CanvasArtifact | PaletteArt | BrandArt | BlueprintArt | LogoArt | ShoppingArt
