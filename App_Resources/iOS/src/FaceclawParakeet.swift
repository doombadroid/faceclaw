import FluidAudio
import Foundation
import os

// FluidAudio's Parakeet TDT 0.6B v3 (batch speech-to-text on the Neural Engine) for the ObjC
// FaceclawSherpa loader, which hands it the Parakeet model folder, and for asr-model.ts.
// FluidAudio is Swift-only: no FluidAudio type appears in an @objc signature, so the generated
// faceclaw-Swift.h never imports it (as FaceclawAlarmKit keeps AlarmKit out).
// One AsrManager stays loaded for the app. The first Neural Engine build after an install or
// update takes 51-181 s on iOS 27 (FluidAudio issue #1022), so warmUp does it in the background
// and asr-model.ts only routes captures here once it has finished for this build.
// Callbacks run on the main thread.
@objc(FaceclawParakeet) public final class FaceclawParakeet: NSObject {
  // FluidInference/parakeet-tdt-0.6b-v3-coreml on Hugging Face (2026-08-19, cc-by-4.0): a mutable
  // branch must not change the files a release loads. Loads check this too, so it is set first.
  private static let repo = "FluidInference/parakeet-tdt-0.6b-v3-coreml"
  private static let revision = "7dd20fe6b1797d35f5e3307e8b1732d9a178edfe"
  private static let folder = "parakeet-tdt-0.6b-v3-coreml"
  private static let warmKey = "parakeet.warmedFor"
  private static let log = Logger(subsystem: "com.faceclaw.app", category: "Parakeet")
  private static let lock = NSLock()
  private static var loading: Task<AsrManager?, Never>?  // under lock
  private static var downloading: Task<Void, Never>?  // under lock
  private static var downloadGeneration = 0  // under lock; a cancelled download's tail must not end its replacement

  // Network only inside download(): a cache FluidAudio finds damaged on load must never
  // re-download 483 MB on its own (cellular included).
  private static let configured: Void = {
    ModelRegistry.revisionOverrides[repo] = revision
    ModelHub.offlineMode = true
  }()

  @objc(isParakeetDir:) public static func isParakeetDir(_ dir: String) -> Bool {
    (dir as NSString).lastPathComponent == folder
  }

  @objc(isDownloadedDir:) public static func isDownloaded(_ dir: String) -> Bool {
    _ = configured
    return AsrModels.modelsExist(at: URL(fileURLWithPath: dir), version: .v3, encoderPrecision: .int8)
  }

  /// Downloaded, and warmUp finished for this app build and iOS version (each redoes the Neural Engine build).
  @objc(isWarmDir:) public static func isWarm(_ dir: String) -> Bool {
    isDownloaded(dir) && UserDefaults.standard.string(forKey: warmKey) == stamp
  }

  private static var stamp: String {
    "\(Bundle.main.infoDictionary?["CFBundleVersion"] ?? "")|\(ProcessInfo.processInfo.operatingSystemVersionString)"
  }

  /// Blocks the caller (FaceclawKit's worker thread) until the text is ready; "" on failure.
  @objc(recognizeSamples:dir:) public static func recognize(_ samples: NSData, dir: String) -> String {
    guard !Thread.isMainThread else { log.error("recognize on the main thread"); return "" }
    let count = samples.length / MemoryLayout<Float>.size
    guard count > 0 else { return "" }
    let floats = Array(UnsafeBufferPointer(start: samples.bytes.assumingMemoryBound(to: Float.self), count: count))
    return block { await transcribe(floats, dir: dir) ?? "" }
  }

  /// Loads the model on the caller's (worker) thread; false when it will not load.
  @objc(loadDir:) public static func loadModel(_ dir: String) -> Bool {
    guard !Thread.isMainThread else { log.error("load on the main thread"); return false }
    return block { await manager(dir) != nil }
  }

  /// Loads the model and decodes 1 s of silence, in the background; done gets nil or the error.
  @objc(warmUpDir:completion:) public static func warmUp(_ dir: String, completion done: @escaping (String?) -> Void) {
    Task.detached(priority: .utility) {
      let failure = await prepare(dir)
      DispatchQueue.main.async { done(failure) }
    }
  }

  /// Fetches the model (only on this explicit call), then warms it up. progress (0-1) covers the
  /// download; done gets nil or the error once the warm-up has finished too.
  @objc(downloadDir:progress:completion:)
  public static func download(_ dir: String, progress: @escaping (Double) -> Void, completion done: @escaping (String?) -> Void) {
    _ = configured
    let generation = lock.withLock { () -> Int in downloadGeneration += 1; return downloadGeneration }
    let task = Task.detached(priority: .utility) {
      var failure: String?
      ModelHub.offlineMode = false
      do {
        // The download phase is the first half of FluidAudio's fraction (compiling is the rest), and
        // it restarts per model file, so the fraction can step back; asr-model.ts keeps the highest.
        try await AsrModels.download(to: URL(fileURLWithPath: dir), version: .v3, encoderPrecision: .int8) { update in
          guard case .downloading = update.phase else { return }
          let fraction = min(1, update.fractionCompleted * 2)
          DispatchQueue.main.async { progress(fraction) }
        }
      } catch {
        failure = Task.isCancelled ? "Download cancelled." : "Parakeet download failed: \(error.localizedDescription)"
      }
      // Only the newest download goes back offline: a replacement may already be fetching.
      let newest = lock.withLock { () -> Bool in
        guard downloadGeneration == generation else { return false }
        downloading = nil
        return true
      }
      if newest { ModelHub.offlineMode = true }
      if failure == nil { failure = await prepare(dir) }
      let result = failure  // a let: a captured var cannot cross into the main-queue closure
      DispatchQueue.main.async { done(result) }
    }
    lock.withLock { if downloadGeneration == generation { downloading = task } }
  }

  /// Stops a download; FluidAudio keeps the partial files and resumes them next time.
  @objc(cancelDownload) public static func cancelDownload() {
    lock.withLock { downloading }?.cancel()
  }

  /// Drops the loaded model and its files.
  @objc(deleteDir:) public static func delete(_ dir: String) {
    lock.withLock { loading = nil }
    UserDefaults.standard.removeObject(forKey: warmKey)
    try? FileManager.default.removeItem(atPath: dir)
  }

  private static func prepare(_ dir: String) async -> String? {
    guard isDownloaded(dir) else { return "The Parakeet model is not downloaded." }
    let start = Date()
    guard await manager(dir) != nil else { return "The Parakeet model could not be loaded. Delete and download it again." }
    _ = await transcribe([Float](repeating: 0, count: 16_000), dir: dir)
    UserDefaults.standard.set(stamp, forKey: warmKey)
    log.info("warm-up took \(Date().timeIntervalSince(start), format: .fixed(precision: 1)) s")
    return nil
  }

  /// The one loaded manager; concurrent callers share one load, and a failed load is retried next call.
  private static func manager(_ dir: String) async -> AsrManager? {
    _ = configured
    let task: Task<AsrManager?, Never> = lock.withLock {
      if let loading { return loading }
      let started = Task<AsrManager?, Never>.detached(priority: .utility) {
        do {
          // .cpuAndNeuralEngine (FluidAudio's default, preprocessor on CPU): no GPU, so it keeps running in the background.
          let models = try await AsrModels.load(from: URL(fileURLWithPath: dir), version: .v3, encoderPrecision: .int8)
          let manager = AsrManager(config: .default)
          try await manager.loadModels(models)
          return manager
        } catch {
          log.error("load failed: \(error.localizedDescription, privacy: .public)")
          return nil
        }
      }
      loading = started
      return started
    }
    let manager = await task.value
    if manager == nil { lock.withLock { loading = nil } }
    return manager
  }

  private static func transcribe(_ samples: [Float], dir: String) async -> String? {
    guard let manager = await manager(dir) else { return nil }
    do {
      var state = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
      return try await manager.transcribe(samples, decoderState: &state).text
    } catch {
      // Under 0.3 s of audio throws too; the next, longer decode recovers.
      log.error("transcribe failed: \(error.localizedDescription, privacy: .public)")
      return nil
    }
  }

  private final class Box<T>: @unchecked Sendable { var value: T? }

  /// Runs body on the cooperative pool and waits; callers are never the main thread or that pool.
  private static func block<T>(_ body: @escaping @Sendable () async -> T) -> T {
    let box = Box<T>(), done = DispatchSemaphore(value: 0)
    Task.detached(priority: .userInitiated) {
      box.value = await body()
      done.signal()
    }
    done.wait()
    return box.value!
  }
}
