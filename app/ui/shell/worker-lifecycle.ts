import { disposeSettingsStore } from "../../native/settings-store";

// Every app worker imports this module. iOS runtime 9.0.3 (WorkerWrapper::CallOnErrorHandlers)
// drops an error thrown from onmessage unless the worker's global onerror is a function; false
// means "not handled here", so it goes on to WorkerAppHost's worker.onerror on the main isolate,
// which files the report. Android's runtime passes it on either way.
(global as unknown as { onerror: (error: unknown) => boolean }).onerror = () => false;

/** Called on the worker after its windows and app-owned resources are closed. */
export function finishWorkerShutdown(): void {
  disposeSettingsStore();
  global.postMessage({ type: "worker-stopped" });
}
