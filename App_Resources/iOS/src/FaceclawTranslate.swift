import Foundation
import ObjectiveC
import SwiftUI
import Translation
import UIKit

// The Translate app's half of Apple's Translation framework (app/native/apple-translate.ios.ts).
// Swift-only API behind ObjC class methods over Foundation types, as FaceclawTranslateSpike does;
// results are JSON strings and completions run on the main thread. Language ids are BCP 47
// ("es", "zh-Hans"). Each pair translates with lowLatency (the downloadable offline packs, ~24 ms
// warm) when its pack is installed, else highFidelity (Apple Intelligence, ~300 ms foreground).
@objc(FaceclawTranslate) public final class FaceclawTranslate: NSObject {
  private static let lock = NSLock()
  private static var fast: [String: Bool] = [:]  // under lock, by pair: lowLatency was installed when last checked
  private static var sessions: [String: TranslationSession] = [:]  // under lock, by pair and strategy
  private static var tails: [String: Task<Void, Never>] = [:]  // under lock, by pair: the last translate queued
  // A translate still running after this is cancelled (its session dropped), so a stuck one
  // cannot hold up its pair's queue; below the JS wrapper's 8 s default.
  private static let translateLimitNs: UInt64 = 6_000_000_000
  // A translate that waited longer than this in its pair's queue is skipped untranslated: its JS
  // caller (8 s default, queue wait included) has all but given up, and dropping it drains a backlog.
  private static let staleNs: UInt64 = 7_000_000_000

  /// done gets {"out","strategy":"lowLatency"|"highFidelity","ms"} or {"error","notInstalled":Bool,"ms"}.
  /// Calls for one pair run one at a time in call order (whether a TranslationSession takes
  /// concurrent translates is undocumented); ms is the translate's own time, not the queue wait.
  @objc(translateText:source:target:completion:)
  public static func translateText(_ text: String, source: String, target: String, completion done: @escaping (String) -> Void) {
    let pair = "\(source)>\(target)"
    let queued = DispatchTime.now().uptimeNanoseconds
    lock.withLock {
      let previous = tails[pair]
      tails[pair] = Task {
        await previous?.value
        let out: String
        if DispatchTime.now().uptimeNanoseconds - queued > staleNs {
          out = json(["error": "stale (queued over \(staleNs / 1_000_000_000) s)", "notInstalled": false, "ms": 0])
        } else {
          out = await run(text, source, target)
        }
        DispatchQueue.main.async { done(out) }
      }
    }
  }

  /// done gets {"lowLatency":S,"highFidelity":S}, S one of installed|supported|unsupported|unknown.
  @objc(statusSource:target:completion:)
  public static func status(_ source: String, target: String, completion done: @escaping (String) -> Void) {
    Task {
      let from = Locale.Language(identifier: source), to = Locale.Language(identifier: target)
      let low = await LanguageAvailability(preferredStrategy: .lowLatency).status(from: from, to: to)
      let high = await LanguageAvailability(preferredStrategy: .highFidelity).status(from: from, to: to)
      let out = json(["lowLatency": name(low), "highFidelity": name(high)])
      DispatchQueue.main.async { done(out) }
    }
  }

  /// Presents a sheet whose .translationTask (lowLatency: the strategy that downloads packs) calls
  /// prepareTranslation(), the only route to the system's download consent. Its completion may
  /// never come back, so the sheet also finishes once the pair reads installed. done gets nil or
  /// the error (Cancel gives up). Either way the pair's cached strategy and sessions are dropped.
  @objc(prepareSource:target:completion:)
  public static func prepare(_ source: String, target: String, completion done: @escaping (String?) -> Void) {
    Task { @MainActor in
      await presentPrepare(source, target) { error in
        forget("\(source)>\(target)")
        note("prepare \(source)>\(target): \(error ?? "done")")
        done(error)
      }
    }
  }

  /// done gets {"languages":[minimal ids]}: the framework default's and lowLatency's together.
  @objc(supportedLanguages:)
  public static func supportedLanguages(_ done: @escaping (String) -> Void) {
    Task {
      let all = await LanguageAvailability().supportedLanguages + LanguageAvailability(preferredStrategy: .lowLatency).supportedLanguages
      let out = json(["languages": Array(Set(all.map { $0.minimalIdentifier })).sorted()])
      DispatchQueue.main.async { done(out) }
    }
  }

  private static func run(_ text: String, _ source: String, _ target: String) async -> String {
    let pair = "\(source)>\(target)"
    let start = DispatchTime.now().uptimeNanoseconds
    let elapsed = { Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000 }
    let from = Locale.Language(identifier: source), to = Locale.Language(identifier: target)
    let low: Bool
    if let cached = lock.withLock({ fast[pair] }) {
      low = cached
    } else {
      let status = await LanguageAvailability(preferredStrategy: .lowLatency).status(from: from, to: to)
      if case .installed = status { low = true } else { low = false }
      lock.withLock { fast[pair] = low }
      note("translate \(pair): lowLatency \(name(status)), using \(low ? "lowLatency" : "highFidelity")")
    }
    let strategy = low ? "lowLatency" : "highFidelity"
    var fresh = false
    let session = lock.withLock { () -> TranslationSession in
      let id = "\(pair)|\(strategy)"
      if let cached = sessions[id] { return cached }
      let made = TranslationSession(installedSource: from, target: to, preferredStrategy: low ? .lowLatency : .highFidelity)
      sessions[id] = made
      fresh = true
      return made
    }
    // isReady costs a round trip, so only a new session asks; a cached one finds out by failing.
    if fresh, !(await session.isReady) {
      forget(pair)
      note("translate \(pair): \(strategy) session not ready")
      return json(["error": "\(source) → \(target) is not installed", "notInstalled": true, "ms": elapsed()])
    }
    // True once it fired. It drops the session before cancelling it, so a translate that succeeds
    // in the same instant cannot leave a cancelled session cached.
    let watchdog = Task { () -> Bool in
      try? await Task.sleep(nanoseconds: translateLimitNs)
      if Task.isCancelled { return false }
      forget(pair)
      session.cancel()
      return true
    }
    defer { watchdog.cancel() }
    do {
      let out = try await session.translate(text).targetText
      return json(["out": out, "strategy": strategy, "ms": elapsed()])
    } catch {
      // Dropped, so the next call re-checks the strategy (a pack downloaded or deleted since).
      forget(pair)
      watchdog.cancel()
      let ms = elapsed(), timedOut = await watchdog.value
      let message = timedOut ? "no translation in \(translateLimitNs / 1_000_000_000) s (cancelled)" : describe(error)
      note("translate \(pair) \(strategy) failed after \(Int(ms)) ms: \(message)")
      return json(["error": message, "notInstalled": TranslationError.notInstalled ~= error, "ms": ms])
    }
  }

  private static func forget(_ pair: String) {
    lock.withLock {
      fast.removeValue(forKey: pair)
      sessions.removeValue(forKey: "\(pair)|lowLatency")
      sessions.removeValue(forKey: "\(pair)|highFidelity")
    }
  }

  fileprivate static func installed(_ source: Locale.Language, _ target: Locale.Language) async -> Bool {
    if case .installed = await LanguageAvailability(preferredStrategy: .lowLatency).status(from: source, to: target) { return true }
    return false
  }

  private static func name(_ status: LanguageAvailability.Status) -> String {
    switch status {
    case .installed: return "installed"
    case .supported: return "supported"
    case .unsupported: return "unsupported"
    @unknown default: return "unknown"
    }
  }

  fileprivate static func describe(_ error: Error) -> String {
    "\(error.localizedDescription) [\(String(describing: error))]"
  }

  private static func json(_ value: [String: Any]) -> String {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else {
      return "{\"error\":\"unencodable result\",\"ms\":0}"
    }
    return String(decoding: data, as: UTF8.self)
  }

  // FaceclawLog (os_log and the remote log) is ObjC that this Swift has no bridging header for,
  // so +[FaceclawLog log:] is looked up at run time.
  private typealias LogFunction = @convention(c) (AnyClass, Selector, NSString) -> Void
  private static let logLine: ((String) -> Void)? = {
    let selector = NSSelectorFromString("log:")
    guard let type = NSClassFromString("FaceclawLog"), let method = class_getClassMethod(type, selector) else { return nil }
    let function = unsafeBitCast(method_getImplementation(method), to: LogFunction.self)
    return { function(type, selector, $0 as NSString) }
  }()

  private static func note(_ message: String) { logLine?("translate: \(message)") }

  @MainActor private static func presentPrepare(_ source: String, _ target: String, _ done: @escaping (String?) -> Void) async {
    // UIKit refuses (logging only, the completion never runs) a present from a controller mid-
    // transition, e.g. the previous pair's sheet still closing: wait that out, up to 10 s. Waiting
    // out a prepare sheet still up keeps a new one from stacking on it and closing along with it.
    var found = topViewController()
    for _ in 0..<40 {
      guard let busy = found, !presentable(busy) else { break }
      try? await Task.sleep(nanoseconds: 250_000_000)
      found = topViewController()
    }
    guard let top = found else { return done("no view controller to present from") }
    guard presentable(top) else { return done("another sheet is still open on the phone") }
    let state = TranslatePrepareState(done)
    let view = TranslatePrepareView(source: Locale.Language(identifier: source), target: Locale.Language(identifier: target),
                                    label: "\(source) → \(target)", finish: { state.finish($0) })
    let host = UIHostingController(rootView: view)
    host.isModalInPresentation = true
    state.host = host
    // .translationTask can finish before the sheet is up; a dismiss sent mid-presentation is
    // ignored, so the state dismisses only once this completion has run.
    top.present(host, animated: true) { MainActor.assumeIsolated { state.presented() } }
  }

  @MainActor private static func presentable(_ top: UIViewController) -> Bool {
    top.view.window != nil && !top.isBeingDismissed && !top.isBeingPresented
      && !(top is UIHostingController<TranslatePrepareView>)
  }

  @MainActor private static func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let windows = scenes.flatMap { $0.windows }
    var top = (windows.first { $0.isKeyWindow } ?? windows.first)?.rootViewController
    while let presented = top?.presentedViewController { top = presented }
    return top
  }
}

/// Reports a prepare sheet once and dismisses it once it is on screen (Cancel always closes it).
@MainActor private final class TranslatePrepareState {
  private var done: ((String?) -> Void)?
  private var shown = false, closing = false
  weak var host: UIViewController?

  init(_ done: @escaping (String?) -> Void) { self.done = done }

  func presented() {
    shown = true
    if closing { host?.dismiss(animated: true) }
  }

  func finish(_ error: String?) {
    closing = true
    if shown { host?.dismiss(animated: true) }
    guard let report = done else { return }
    done = nil
    report(error)
  }
}

private struct TranslatePrepareView: View {
  let source: Locale.Language
  let target: Locale.Language
  let label: String
  let finish: @MainActor (String?) -> Void

  var body: some View {
    VStack(spacing: 16) {
      ProgressView()
      Text("Downloading translation \(label)")
      Button("Cancel") { finish("cancelled on the phone") }
    }
    .padding(32)
    .translationTask(source: source, target: target, preferredStrategy: .lowLatency) { session in
      let failure: String?
      do {
        try await session.prepareTranslation()
        failure = nil
      } catch {
        failure = FaceclawTranslate.describe(error)
      }
      await MainActor.run { finish(failure) }
    }
    // prepareTranslation() can download and still never return: finish once the pack reads installed.
    .task {
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        if await FaceclawTranslate.installed(source, target) {
          await MainActor.run { finish(nil) }
          return
        }
      }
    }
  }
}
