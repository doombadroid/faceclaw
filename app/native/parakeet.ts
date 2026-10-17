/**
 * FluidAudio's Parakeet speech model (App_Resources/iOS/src/FaceclawParakeet.swift) exists only
 * on iOS, where parakeet.ios.ts returns the native class. Elsewhere there is none, and
 * asr-model.ts treats the model as never downloaded.
 */
export type FluidNative = {
  isDownloadedDir(dir: string): boolean;
  /** Downloaded and warmed up for this app build and iOS version. */
  isWarmDir(dir: string): boolean;
  /** progress (0-1) covers the download; done (nil or the error) follows the warm-up. */
  downloadDirProgressCompletion(dir: string, progress: (fraction: number) => void, done: (error: string | null) => void): void;
  warmUpDirCompletion(dir: string, done: (error: string | null) => void): void;
  cancelDownload(): void;
  deleteDir(dir: string): void;
};

export function fluidNative(): FluidNative | null {
  return null;
}
