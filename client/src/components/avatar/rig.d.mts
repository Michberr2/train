export type AvatarPhase = 'listening' | 'talking' | 'thinking' | null
export class NaluAvatar {
  constructor(canvas: HTMLCanvasElement, options: { src: string; strength?: number; autoPlay?: boolean; transparent?: boolean; trackTarget?: EventTarget; onError?: (error: Error) => void })
  loaded: Promise<NaluAvatar>
  ready: boolean
  running: boolean
  destroyed: boolean
  look: number[]
  target: number[]
  clock: number
  setLook(x: number, y: number): void
  returnHome(): void
  setActivity(phase: AvatarPhase, input?: number): void
  setReducedMotion(reduced: boolean): void
  setActive(active: boolean): void
  bounce(): void
  pause(): void
  play(): void
  renderStill(x?: number, y?: number): void
  destroy(): void
}
