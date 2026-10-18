import { fromData, throwIfError, toData } from '../native/kotlin-data'
export type SurfaceRect = { x: number; y: number; width: number; height: number }
export type SurfaceConfiguration = SurfaceRect & {
  zOrder: number
  transparency: 'opaque' | 'color-key'
}
/** Retained pixels, clipping, layers and composition live in shared Kotlin. */
export class SurfaceCompositor {
  private native: FaceclawKitIosSurfaceCompositor
  private readonly surfaces = new Set<string>()
  constructor(readonly width: number, readonly height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error('Invalid compositor size')
    this.native = FaceclawKitIosSurfaceCompositor.alloc().initWithWidthHeight(width, height)
  }
  configureSurface(id: string, options: SurfaceConfiguration): void {
    if (![options.x, options.y, options.width, options.height, options.zOrder].every(Number.isInteger)
      || options.width <= 0 || options.height <= 0) throw new Error('Invalid surface geometry')
    throwIfError(this.native.configureIdXYWidthHeightZOrderTransparent(id, options.x, options.y, options.width, options.height, options.zOrder, options.transparency === 'color-key'))
    this.surfaces.add(id)
  }
  removeSurface(id: string): void { throwIfError(this.native.removeId(id)); this.surfaces.delete(id) }
  setSurfaceVisible(id: string, visible: boolean): void { throwIfError(this.native.visibleIdVisible(id, visible)) }
  setSurfaceDepth(id: string, depth: number): void { throwIfError(this.native.depthIdDepth(id, depth)) }
  setUnderlayDim(belowZOrder: number, factor: number): void {
    if (!Number.isFinite(factor)) throw new Error('Invalid dim factor')
    throwIfError(this.native.dimBelowFactor(belowZOrder, factor))
  }
  setScreenBlanked(blanked: boolean): void { throwIfError(this.native.blankBlanked(blanked)) }
  submitSurfaceFrame(id: string, pixels: Uint8Array, rect: SurfaceRect, draws: ArrayBuffer | null = null): void {
    if (!this.surfaces.has(id)) throw new Error(`Unknown surface: ${id}`)
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger)
      || rect.width <= 0 || rect.height <= 0 || pixels.length !== rect.width * rect.height) throw new Error('Invalid frame buffer or rectangle')
    throwIfError(this.native.submitDrawsIdDataXYWidthHeightDraws(id, toData(pixels), rect.x, rect.y, rect.width, rect.height,
      draws ? toData(new Uint8Array(draws)) : null))
  }
  setShellScene(bytes: Uint8Array): void { throwIfError(this.native.shellData(toData(bytes))) }
  composite(): Uint8Array { return fromData(this.native.composite()) }
  /** Called on the main queue after each step of an animation the preview is replaying. */
  setPreviewAnimationListener(listener: (() => void) | null): void { this.native.setPreviewAnimationListenerListener(listener) }
}
