import { Utils } from "@nativescript/core";

declare const com: any;
declare const java: any;

/**
 * The platform half of the on-device model downloads (asr-model.ts,
 * mic-models.ts): where models live, one resumable sha256-checked file
 * download, and the file checks. Android: filesDir and
 * FaceclawModelDownloader; iOS: model-downloader.ios.ts.
 */

export type ModelDownloadCallbacks = {
  /** Bytes of this file so far (resumed bytes included). */
  onProgress: (bytes: number) => void;
  /** The file is verified and at its final path. */
  onDone: () => void;
  onError: (message: string) => void;
};

/** A running download; cancel keeps the .part file so the next start resumes. */
export type ModelDownload = { cancel(): void };

export function modelsRoot(): string {
  return String(Utils.android.getApplicationContext().getFilesDir().getAbsolutePath());
}

/** Starts the download; throws when it cannot start. Callbacks arrive on the main thread. */
export function startModelDownload(
  url: string,
  destPath: string,
  sha256: string,
  sizeBytes: number,
  callbacks: ModelDownloadCallbacks,
): ModelDownload {
  // Referenced only from Java while the download runs; the handle holds it.
  const listener = new com.faceclaw.app.FaceclawModelDownloaderListener({
    onProgress: (bytes: number, _total: number) => callbacks.onProgress(Number(bytes)),
    onDone: () => callbacks.onDone(),
    onError: (message: string) => callbacks.onError(String(message)),
  });
  const downloader = new com.faceclaw.app.FaceclawModelDownloader(url, destPath, sha256, sizeBytes, listener);
  downloader.start();
  return { cancel: () => downloader.cancel(), listener } as ModelDownload;
}

/** A downloaded (non-empty) file is at path. */
export function isModelFilePresent(path: string): boolean {
  try {
    const file = new java.io.File(path);
    return file.exists() && file.length() > 0;
  } catch {
    return false;
  }
}

/** Deletes each file and its .part, then the (now empty) directory. Throws on a platform error. */
export function deleteModelFiles(dirPath: string, fileNames: string[]): void {
  for (const name of fileNames) {
    new java.io.File(`${dirPath}/${name}`).delete();
    new java.io.File(`${dirPath}/${name}.part`).delete();
  }
  new java.io.File(dirPath).delete();
}
