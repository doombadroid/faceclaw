/**
 * iOS twin of model-downloader.ts: models live in Library/Application
 * Support/models (kept out of iCloud backup; they re-download), and each file
 * comes through FaceclawKit's IosModelDownloader (the shared ResumableDownload:
 * .part resume, pinned sha256, listener on the main queue).
 */
import { knownFolders } from "@nativescript/core";

import type { ModelDownload, ModelDownloadCallbacks } from "./model-downloader";
import { kotlinListener } from "./kotlin-listener.ios";

export type { ModelDownload, ModelDownloadCallbacks } from "./model-downloader";

declare const FaceclawKitIosModelDownloader: any;
declare const FaceclawKitFaceclawModelDownloaderListener: any;

let root: string | null = null;

export function modelsRoot(): string {
  if (root) return root;
  const path = `${knownFolders.ios.library().path}/Application Support/models`;
  try {
    NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(path, true, null);
    NSURL.fileURLWithPath(path).setResourceValueForKeyError(true, NSURLIsExcludedFromBackupKey);
  } catch (error) {
    console.warn(`model folder setup failed: ${error}`);
  }
  root = path;
  return path;
}

export function startModelDownload(
  url: string,
  destPath: string,
  sha256: string,
  sizeBytes: number,
  callbacks: ModelDownloadCallbacks,
): ModelDownload {
  // Kotlin holds the listener while the download runs; the handle keeps the JS side alive too.
  const listener = kotlinListener(FaceclawKitFaceclawModelDownloaderListener, {
    onProgressBytesDownloadedTotalBytes: (bytes: number, _total: number) => callbacks.onProgress(Number(bytes)),
    onDonePath: (_path: string | null) => callbacks.onDone(),
    onErrorMessage: (message: string | null) => callbacks.onError(String(message ?? "download failed")),
  });
  const downloader = FaceclawKitIosModelDownloader.alloc()
    .initWithUrlDestPathExpectedSha256ExpectedTotalBytesListener(url, destPath, sha256, sizeBytes, listener);
  downloader.start();
  return { cancel: () => downloader.cancel(), listener } as ModelDownload;
}

export function isModelFilePresent(path: string): boolean {
  try {
    return Number(NSFileManager.defaultManager.attributesOfItemAtPathError(path).objectForKey(NSFileSize)) > 0;
  } catch {
    return false;
  }
}

export function deleteModelFiles(dirPath: string, fileNames: string[]): void {
  for (const path of [...fileNames.flatMap((name) => [`${dirPath}/${name}`, `${dirPath}/${name}.part`]), dirPath]) {
    if (!NSFileManager.defaultManager.fileExistsAtPath(path)) continue;
    NSFileManager.defaultManager.removeItemAtPathError(path);
  }
}
