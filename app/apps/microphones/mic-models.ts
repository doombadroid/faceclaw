import {
  deleteModelFiles,
  isModelFilePresent,
  modelsRoot,
  startModelDownload,
  type ModelDownload,
} from "../../native/model-downloader";

/**
 * Download management for the Microphones app's on-device models, mirroring
 * the Moonshine flow in app/native/asr-model.ts (model-downloader, resume +
 * pinned sha256 per file):
 *
 * - Speaker embedding (WeSpeaker CAM++ English, 512-dim): voice-prints for
 *   caption attribution, wearer recognition, and re-diarization.
 * - Pyannote segmentation 3.0: offline re-diarization of saved recordings.
 *
 * The caption ASR model itself is the shared Moonshine download managed by
 * asr-model.ts; this module only adds the speaker models.
 */

export type MicModelId = "speaker-embedding" | "diarization-segmentation";

type MicModelFile = {
  /** Local file name under the model directory. */
  name: string;
  /** Source file name in the mirror repo (may differ from the local name). */
  remoteName: string;
  sha256: string;
  sizeBytes: number;
};

type MicModel = {
  id: MicModelId;
  label: string;
  baseUrl: string;
  files: MicModelFile[];
  totalBytes: number;
};

// Hugging Face mirrors of the sherpa-onnx release assets (served per-file,
// sha256 pinned from the repos' LFS pointers).
export const MIC_MODELS: MicModel[] = [
  {
    id: "speaker-embedding",
    label: "Speaker voices (WeSpeaker English)",
    baseUrl: "https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main/",
    files: [
      {
        name: "speaker-embedding.onnx",
        remoteName: "wespeaker_en_voxceleb_CAM%2B%2B.onnx",
        sha256: "c46fad10b5f81e1aa4a60c162714208577093655076c5450f8c469e522ec54ef",
        sizeBytes: 29292684,
      },
    ],
    totalBytes: 29292684,
  },
  {
    id: "diarization-segmentation",
    label: "Speaker turns (pyannote segmentation)",
    baseUrl: "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/",
    files: [
      {
        name: "segmentation.onnx",
        remoteName: "model.onnx",
        sha256: "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079",
        sizeBytes: 5992913,
      },
    ],
    totalBytes: 5992913,
  },
];

export type MicModelState = {
  status: "absent" | "downloading" | "ready";
  bytesDownloaded: number;
  totalBytes: number;
};

const downloaders = new Map<MicModelId, ModelDownload>();
const progress = new Map<MicModelId, number>();
const stateListeners = new Set<(id: MicModelId, state: MicModelState) => void>();

function model(id: MicModelId): MicModel {
  const found = MIC_MODELS.find((entry) => entry.id === id);
  if (!found) throw new Error(`unknown mic model ${id}`);
  return found;
}

function modelDirPath(id: MicModelId): string {
  return `${modelsRoot()}/faceclaw-mic-models/${id}`;
}

function filePath(id: MicModelId, file: MicModelFile): string {
  return `${modelDirPath(id)}/${file.name}`;
}

function isFilePresent(id: MicModelId, file: MicModelFile): boolean {
  return isModelFilePresent(filePath(id, file));
}

export function isMicModelReady(id: MicModelId): boolean {
  return model(id).files.every((file) => isFilePresent(id, file));
}

/** Absolute path of a ready model's primary file, or null when absent. */
export function micModelPath(id: MicModelId): string | null {
  if (!isMicModelReady(id)) return null;
  return filePath(id, model(id).files[0]!);
}

export function micModelState(id: MicModelId): MicModelState {
  if (downloaders.has(id)) {
    return {
      status: "downloading",
      bytesDownloaded: progress.get(id) ?? 0,
      totalBytes: model(id).totalBytes,
    };
  }
  return {
    status: isMicModelReady(id) ? "ready" : "absent",
    bytesDownloaded: 0,
    totalBytes: model(id).totalBytes,
  };
}

export function onMicModelStateChanged(
  listener: (id: MicModelId, state: MicModelState) => void,
): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

function notifyStateChanged(id: MicModelId): void {
  const state = micModelState(id);
  stateListeners.forEach((listener) => listener(id, state));
}

export function startMicModelDownload(id: MicModelId): void {
  if (downloaders.has(id) || isMicModelReady(id)) return;
  progress.delete(id);
  downloadNextFile(id);
  notifyStateChanged(id);
}

function downloadNextFile(id: MicModelId): void {
  const definition = model(id);
  const nextFile = definition.files.find((file) => !isFilePresent(id, file));
  if (!nextFile) {
    downloaders.delete(id);
    notifyStateChanged(id);
    return;
  }
  const completedBytes = definition.files
    .filter((file) => isFilePresent(id, file))
    .reduce((sum, file) => sum + file.sizeBytes, 0);
  try {
    downloaders.set(id, startModelDownload(`${definition.baseUrl}${nextFile.remoteName}`, filePath(id, nextFile), nextFile.sha256, nextFile.sizeBytes, {
      onProgress: (bytes) => {
        progress.set(id, completedBytes + bytes);
        notifyStateChanged(id);
      },
      onDone: () => {
        downloadNextFile(id);
      },
      onError: (message) => {
        console.error(`Mic model download failed (${id}/${nextFile.name}): ${message}`);
        downloaders.delete(id);
        notifyStateChanged(id);
      },
    }));
  } catch (error) {
    // Without this, a dead entry would pin the model at "downloading".
    console.error(`Mic model download failed to start (${id}/${nextFile.name}): ${String(error)}`);
    downloaders.delete(id);
    notifyStateChanged(id);
  }
}

export function cancelMicModelDownload(id: MicModelId): void {
  const downloader = downloaders.get(id);
  if (!downloader) return;
  downloader.cancel();
  downloaders.delete(id);
  notifyStateChanged(id);
}

export function deleteMicModel(id: MicModelId): void {
  cancelMicModelDownload(id);
  try {
    deleteModelFiles(modelDirPath(id), model(id).files.map((file) => file.name));
  } catch (error) {
    console.error(`Mic model delete failed: ${String(error)}`);
  }
  notifyStateChanged(id);
}
