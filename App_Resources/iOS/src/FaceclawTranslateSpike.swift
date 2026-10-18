import Foundation
import Speech
import SwiftUI
import Translation
import UIKit

// The translation spike's native half (Settings > General > Translate Tests): Apple's Translation
// framework and SpeechTranscriber's locales. Both are Swift-only, so, as FaceclawAlarmKit does,
// this exposes ObjC class methods over Foundation types and returns results as JSON strings.
// The app's minimum is iOS 26.4, which every API here needs at most (the Strategy initialisers).
// Language ids are BCP 47 ("es", "zh-Hans"); pairs are "source>target". Completions run on the main thread.
@objc(FaceclawTranslateSpike) public final class FaceclawTranslateSpike: NSObject {
  private static let lock = NSLock()
  private static var sessions: [String: TranslationSession] = [:]  // under lock, by pair and strategy

  /// pairs: "es>en,fr>en"; strategy: 0 the framework default, 1 lowLatency, 2 highFidelity.
  /// done gets {"supported":[language ids],"pairs":{"es>en":"installed"|"supported"|"unsupported"}}.
  @objc(availabilityPairs:strategy:completion:)
  public static func availability(_ pairs: String, strategy: Int, completion done: @escaping (String) -> Void) {
    Task {
      let checker = FaceclawTranslateSpike.preferred(strategy).map { LanguageAvailability(preferredStrategy: $0) } ?? LanguageAvailability()
      var statuses: [String: String] = [:]
      for pair in pairs.split(separator: ",").map(String.init) {
        let ids = pair.split(separator: ">").map(String.init)
        guard ids.count == 2 else { statuses[pair] = "bad pair"; continue }
        let status = await checker.status(from: Locale.Language(identifier: ids[0]), to: Locale.Language(identifier: ids[1]))
        statuses[pair] = FaceclawTranslateSpike.name(status)
      }
      let languages = await checker.supportedLanguages
      let out = FaceclawTranslateSpike.json(["supported": languages.map { $0.minimalIdentifier }, "pairs": statuses])
      DispatchQueue.main.async { done(out) }
    }
  }

  /// Presents a sheet whose SwiftUI .translationTask calls prepareTranslation(), the only route to the
  /// system's language-download consent. done gets nil, or the error (a Cancel button gives up).
  @objc(prepareSource:target:completion:)
  public static func prepare(_ source: String, target: String, completion done: @escaping (String?) -> Void) {
    Task { @MainActor in FaceclawTranslateSpike.presentPrepare(source, target, done) }
  }

  /// Translates linesJson (a JSON array of strings) one line at a time with an installed-languages
  /// session (kept per pair and strategy, so a second call measures a warm one). done gets
  /// {"ready":Bool,"rows":[{"text","out"|"error","ms"}]}.
  @objc(translateLines:source:target:strategy:completion:)
  public static func translate(_ linesJson: String, source: String, target: String, strategy: Int,
                               completion done: @escaping (String) -> Void) {
    let lines = (try? JSONSerialization.jsonObject(with: Data(linesJson.utf8))) as? [String] ?? []
    Task {
      let session = FaceclawTranslateSpike.session(source, target, strategy)
      let ready = await session.isReady
      var rows: [[String: Any]] = []
      for line in lines {
        let start = DispatchTime.now().uptimeNanoseconds
        var row: [String: Any] = ["text": line]
        do {
          row["out"] = try await session.translate(line).targetText
        } catch {
          row["error"] = FaceclawTranslateSpike.describe(error)
        }
        row["ms"] = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
        rows.append(row)
      }
      let out = FaceclawTranslateSpike.json(["ready": ready, "rows": rows])
      DispatchQueue.main.async { done(out) }
    }
  }

  /// done gets {"available":Bool,"supported":[locale ids],"installed":[locale ids]} for SpeechTranscriber.
  @objc(speechLocales:) public static func speechLocales(_ done: @escaping (String) -> Void) {
    Task {
      let supported = await SpeechTranscriber.supportedLocales
      let installed = await SpeechTranscriber.installedLocales
      let out = FaceclawTranslateSpike.json([
        "available": SpeechTranscriber.isAvailable,
        "supported": supported.map { $0.identifier },
        "installed": installed.map { $0.identifier },
      ])
      DispatchQueue.main.async { done(out) }
    }
  }

  private static func preferred(_ strategy: Int) -> TranslationSession.Strategy? {
    switch strategy {
    case 1: return .lowLatency
    case 2: return .highFidelity
    default: return nil
    }
  }

  private static func session(_ source: String, _ target: String, _ strategy: Int) -> TranslationSession {
    lock.withLock { () -> TranslationSession in
      let key = "\(source)>\(target)|\(strategy)"
      if let cached = sessions[key] { return cached }
      let from = Locale.Language(identifier: source), to = Locale.Language(identifier: target)
      let made = preferred(strategy).map { TranslationSession(installedSource: from, target: to, preferredStrategy: $0) }
        ?? TranslationSession(installedSource: from, target: to)
      sessions[key] = made
      return made
    }
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
      return "{\"error\":\"unencodable result\"}"
    }
    return String(decoding: data, as: UTF8.self)
  }

  @MainActor private static func presentPrepare(_ source: String, _ target: String, _ done: @escaping (String?) -> Void) {
    guard let top = topViewController() else { return done("no view controller to present from") }
    let state = PrepareState(done)
    let view = PrepareView(source: Locale.Language(identifier: source), target: Locale.Language(identifier: target),
                           label: "\(source) → \(target)", finish: { state.finish($0) })
    let host = UIHostingController(rootView: view)
    host.isModalInPresentation = true
    state.host = host
    top.present(host, animated: true)
  }

  @MainActor private static func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let windows = scenes.flatMap { $0.windows }
    var top = (windows.first { $0.isKeyWindow } ?? windows.first)?.rootViewController
    while let presented = top?.presentedViewController { top = presented }
    return top
  }
}

/// Finishes a prepare sheet once: dismisses it and reports to JS.
@MainActor private final class PrepareState {
  private var done: ((String?) -> Void)?
  weak var host: UIViewController?

  init(_ done: @escaping (String?) -> Void) { self.done = done }

  func finish(_ error: String?) {
    guard let report = done else { return }
    done = nil
    host?.dismiss(animated: true)
    report(error)
  }
}

private struct PrepareView: View {
  let source: Locale.Language
  let target: Locale.Language
  let label: String
  let finish: @MainActor (String?) -> Void

  var body: some View {
    VStack(spacing: 16) {
      ProgressView()
      Text("Preparing translation \(label)")
      Button("Cancel") { finish("cancelled on the phone") }
    }
    .padding(32)
    .translationTask(source: source, target: target) { session in
      let failure: String?
      do {
        try await session.prepareTranslation()
        failure = nil
      } catch {
        failure = FaceclawTranslateSpike.describe(error)
      }
      await MainActor.run { finish(failure) }
    }
  }
}
