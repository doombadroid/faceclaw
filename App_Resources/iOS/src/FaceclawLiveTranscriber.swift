import AVFoundation
import CoreMedia
import Foundation
import Speech

// Live on-device speech-to-text for Translate's Listen mode: Apple's SpeechAnalyzer with one
// SpeechTranscriber per session (iOS 26), fed the glasses' 16 kHz mono S16LE PCM from JS. Two
// sessions (the pair's two languages) run at once over the same chunks; each session's audio clock
// counts the samples it was given from 0, so both report the same times for the same speech.
// Swift-only API, so, as FaceclawTranslateSpike does, this exposes ObjC class methods over
// Foundation types. Language ids are ours ("es", "zh-Hans"); results are JSON on the main thread.
// Nothing here downloads a model implicitly: only installLanguage does.
@objc(FaceclawLiveTranscriber) public final class FaceclawLiveTranscriber: NSObject {
  private static let lock = NSLock()
  private static var sessions: [Int: LiveTranscription] = [:]  // under lock; a session leaves once ended
  private static var lastHandle = 0  // under lock
  private static var recent: [String] = []  // under lock: language codes of the last two installed or started

  // Our ids to the locale asked for; supportedLocale(equivalentTo:) then picks the transcriber's own.
  private static let regions = ["en": "en-US", "es": "es-ES", "fr": "fr-FR", "de": "de-DE", "it": "it-IT",
                                "pt": "pt-BR", "ja": "ja-JP", "ko": "ko-KR", "zh-Hans": "zh-CN"]

  /// The glasses' audio as JS sends it.
  fileprivate static let pcmFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)

  /// done gets {"supported":Bool,"installed":Bool,"locale":String} (locale: the transcriber's BCP 47 tag).
  @objc(statusLanguage:completion:)
  public static func status(_ language: String, completion done: @escaping (String) -> Void) {
    Task {
      let out: String
      if SpeechTranscriber.isAvailable, let locale = await supportedLocale(language) {
        let installed = await AssetInventory.status(forModules: [transcriber(locale)]) == .installed
        out = json(["supported": true, "installed": installed, "locale": locale.identifier(.bcp47)])
      } else {
        out = json(["supported": false, "installed": false, "locale": regions[language] ?? language])
      }
      DispatchQueue.main.async { done(out) }
    }
  }

  /// Downloads the language's model (the system may show its own progress); done gets nil or the error.
  @objc(installLanguage:completion:)
  public static func install(_ language: String, completion done: @escaping (String?) -> Void) {
    Task {
      let failure = await installAssets(language)
      if let failure { note("install \(language): \(failure)") } else { note("install \(language): ready") }
      DispatchQueue.main.async { done(failure) }
    }
  }

  /// Starts a session and returns its handle at once; setup continues in the background. events gets
  /// {"kind":"ready","locale"}, {"kind":"partial"|"final","text","conf","start","end"} (seconds from
  /// the first sample accepted; conf 0-1, -1 unknown), {"kind":"error","message"}, and {"kind":"ended"}
  /// exactly once, last. A language whose model is not installed gets an error, then ended.
  @objc(startLanguage:events:)
  public static func start(_ language: String, events: @escaping (String) -> Void) -> Int {
    let handle = lock.withLock { () -> Int in
      lastHandle += 1
      return lastHandle
    }
    let session = LiveTranscription(handle: handle, language: language, events: events)
    lock.withLock { sessions[handle] = session }
    session.begin()
    return handle
  }

  /// 16 kHz mono S16LE. Cheap on the caller's thread: the work happens on the session's queue.
  /// Audio that arrives while the session starts is held (up to 10 s) and fed in order.
  @objc(acceptHandle:pcm:)
  public static func accept(_ handle: Int, pcm: Data) {
    lock.withLock { sessions[handle] }?.accept(pcm)
  }

  /// Ends the input: the remaining audio is transcribed and finalized, then ended.
  @objc(finishHandle:)
  public static func finish(_ handle: Int) {
    lock.withLock { sessions[handle] }?.finish()
  }

  /// Finalizes everything up to `seconds` (this session's audio clock) now, rather than when the
  /// transcriber decides to; then events gets {"kind":"finalized","through"} after those finals.
  /// Listen calls it at each pause it detects, so both languages' finals cover the same stretch.
  @objc(finalizeHandle:through:)
  public static func finalize(_ handle: Int, through seconds: Double) {
    lock.withLock { sessions[handle] }?.finalize(through: seconds)
  }

  /// Stops at once, dropping unfinished results, then ended.
  @objc(cancelHandle:)
  public static func cancel(_ handle: Int) {
    lock.withLock { sessions[handle] }?.cancel()
  }

  fileprivate static func forget(_ handle: Int) {
    lock.withLock { _ = sessions.removeValue(forKey: handle) }
  }

  fileprivate static func transcriber(_ locale: Locale) -> SpeechTranscriber {
    SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults],
                      attributeOptions: [.audioTimeRange, .transcriptionConfidence])
  }

  /// The transcriber's locale for one of our ids, or nil when it has none.
  fileprivate static func supportedLocale(_ language: String) async -> Locale? {
    let requested = Locale(identifier: regions[language] ?? language)
    guard let match = await SpeechTranscriber.supportedLocale(equivalentTo: requested) else { return nil }
    // It can answer with a tag it cannot transcribe; trust it only when the transcriber lists it.
    let tag = match.identifier(.bcp47)
    let supported = await SpeechTranscriber.supportedLocales
    let installed = await SpeechTranscriber.installedLocales
    return (supported + installed).contains { $0.identifier(.bcp47) == tag } ? match : nil
  }

  private static func installAssets(_ language: String) async -> String? {
    guard SpeechTranscriber.isAvailable else { return "On-device speech recognition is not available on this iPhone." }
    guard let locale = await supportedLocale(language) else { return "Speech recognition does not support \(language)." }
    let tag = locale.identifier(.bcp47)
    let module = transcriber(locale)
    remember(locale)
    do {
      if await AssetInventory.status(forModules: [module]) == .installed { return nil }
      await makeRoom(for: locale)
      // The request reserves the locale itself (and throws past maximumReservedLocales).
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
        try await request.downloadAndInstall()
      }
    } catch {
      return "Could not download \(tag) speech recognition: \(describe(error))"
    }
    // downloadAndInstall can return while the system is still installing: wait for the status.
    for _ in 0..<240 {
      switch await AssetInventory.status(forModules: [module]) {
      case .installed: return nil
      case .unsupported: return "Speech recognition does not support \(tag) on this iPhone."
      default: try? await Task.sleep(nanoseconds: 500_000_000)
      }
    }
    return "\(tag) speech recognition is still downloading. Check again shortly."
  }

  /// Reserves an installed model's locale that is not reserved yet (installed by the system or
  /// another app: only assetInstallationRequest reserves, and the analyzer may require it).
  fileprivate static func keepReserved(_ locale: Locale) async {
    remember(locale)
    let tag = locale.identifier(.bcp47)
    let reserved = await AssetInventory.reservedLocales
    guard !reserved.contains(where: { $0.identifier(.bcp47) == tag }) else { return }
    await makeRoom(for: locale)
    do { try await AssetInventory.reserve(locale: locale) } catch { note("reserve \(tag): \(describe(error))") }
  }

  private static func remember(_ locale: Locale) {
    let language = code(locale)
    lock.withLock { recent = Array((recent.filter { $0 != language } + [language]).suffix(2)) }
  }

  /// Frees a locale reservation when the app is at maximumReservedLocales, never one a running
  /// session uses or one of the last two installed or started (the pair one Download missing run
  /// installs back to back). ponytail: otherwise any reservation goes (Apple documents no order);
  /// with none spare, the request throws tooManyAssetLocalesAllocated, described in plain words.
  private static func makeRoom(for locale: Locale) async {
    let tag = locale.identifier(.bcp47)
    let reserved = await AssetInventory.reservedLocales
    guard reserved.count >= AssetInventory.maximumReservedLocales,
          !reserved.contains(where: { $0.identifier(.bcp47) == tag }) else { return }
    let busy = lock.withLock { Set(sessions.values.map { code(Locale(identifier: regions[$0.language] ?? $0.language)) } + recent) }
    guard let spare = reserved.first(where: { $0.identifier(.bcp47) != tag && !busy.contains(code($0)) }) else { return }
    note("releasing the \(spare.identifier(.bcp47)) speech reservation for \(tag)")
    await AssetInventory.release(reservedLocale: spare)
  }

  private static func code(_ locale: Locale) -> String { locale.language.languageCode?.identifier ?? locale.identifier }

  fileprivate static func describe(_ error: Error) -> String {
    let ns = error as NSError
    if ns.domain == SFSpeechErrorDomain {
      switch ns.code {
      case SFSpeechError.Code.insufficientResources.rawValue:
        return "iOS has no resources for another speech recognizer right now (two languages at once may be too many for this iPhone)."
      case SFSpeechError.Code.assetLocaleNotAllocated.rawValue:
        return "iOS has not reserved this language's speech recognition for OcuSmart."
      case SFSpeechError.Code.tooManyAssetLocalesAllocated.rawValue:
        return "OcuSmart has reserved as many speech recognition languages as iOS allows."
      case SFSpeechError.Code.noModel.rawValue:
        return "No speech recognition model is available for this language on this iPhone."
      default: break
      }
    }
    var message = "\(error.localizedDescription) [\(String(describing: error))]"
    let auth = SFSpeechRecognizer.authorizationStatus()
    if auth == .denied || auth == .restricted { message += " Allow Speech Recognition for OcuSmart in iPhone Settings." }
    return message
  }

  fileprivate static func json(_ value: [String: Any]) -> String {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else {
      return "{\"kind\":\"error\",\"message\":\"unencodable event\"}"
    }
    return String(decoding: data, as: UTF8.self)
  }

  // FaceclawLog (os_log and the remote log) is ObjC that this Swift has no bridging header for,
  // so +[FaceclawLog log:] is looked up at run time (as FaceclawTranslate does).
  private typealias LogFunction = @convention(c) (AnyClass, Selector, NSString) -> Void
  private static let logLine: ((String) -> Void)? = {
    let selector = NSSelectorFromString("log:")
    guard let type = NSClassFromString("FaceclawLog"), let method = class_getClassMethod(type, selector) else { return nil }
    let function = unsafeBitCast(method_getImplementation(method), to: LogFunction.self)
    return { function(type, selector, $0 as NSString) }
  }()

  fileprivate static func note(_ message: String) { logLine?("speech: \(message)") }
}

/// One SpeechAnalyzer and its SpeechTranscriber. Every var is touched only on queue, which also
/// orders the events; they reach JS through the main queue in that order.
private final class LiveTranscription: @unchecked Sendable {
  private enum Phase { case starting, running, finishing, ended }

  let handle: Int
  let language: String
  private let events: (String) -> Void
  private let queue: DispatchQueue
  private var phase = Phase.starting
  private var finishRequested = false
  private var pending: [Data] = []  // PCM accepted while starting
  private var pendingBytes = 0
  private var skippedSamples = 0  // the oldest PCM dropped past the 10 s hold; it still counts as time
  private var analyzer: SpeechAnalyzer?
  private var input: AsyncStream<AnalyzerInput>.Continuation?
  private var results: Task<Void, Never>?
  private var format: AVAudioFormat?
  private var converter: AVAudioConverter?
  private var fed: Int64 = 0  // analyzer-format frames yielded: the next buffer's start time

  private static let maxPendingBytes = 10 * 32_000

  init(handle: Int, language: String, events: @escaping (String) -> Void) {
    self.handle = handle
    self.language = language
    self.events = events
    queue = DispatchQueue(label: "com.faceclaw.live-transcriber.\(handle)")
  }

  func begin() {
    Task.detached(priority: .userInitiated) { [self] in
      if let failure = await setUp() {
        queue.async { [self] in
          post(error: failure)
          end()
        }
      }
    }
  }

  func accept(_ pcm: Data) {
    queue.async { [self] in
      switch phase {
      case .starting: hold(pcm)
      case .running: feed(pcm)
      case .finishing, .ended: break
      }
    }
  }

  func finish() {
    queue.async { [self] in
      switch phase {
      case .starting: finishRequested = true
      case .running: beginFinish()
      case .finishing, .ended: break
      }
    }
  }

  func finalize(through seconds: Double) {
    queue.async { [self] in
      guard phase == .running, let analyzer, let format, seconds.isFinite, seconds > 0 else { return }
      let time = CMTime(value: Int64((seconds * format.sampleRate).rounded()), timescale: CMTimeScale(format.sampleRate))
      Task { [self] in
        do { try await analyzer.finalize(through: time) } catch { return }  // finishing or cancelled: ended follows
        // finalize publishes the finals to the results stream before returning, but read() may not
        // have taken them yet. ponytail: a short sleep orders them first; a handshake if it ever doesn't.
        try? await Task.sleep(nanoseconds: 150_000_000)
        queue.async { [self] in post(["kind": "finalized", "through": seconds]) }
      }
    }
  }

  func cancel() {
    queue.async { [self] in
      guard phase != .ended else { return }
      let analyzer = self.analyzer
      results?.cancel()
      end()
      if let analyzer { Task { await analyzer.cancelAndFinishNow() } }
    }
  }

  /// Everything up to a running analyzer; nil once it runs, else the error to report.
  private func setUp() async -> String? {
    if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
      _ = await withCheckedContinuation { (done: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
        SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0) }
      }
    }
    guard SpeechTranscriber.isAvailable else { return "On-device speech recognition is not available on this iPhone." }
    guard let locale = await FaceclawLiveTranscriber.supportedLocale(language) else {
      return "Speech recognition does not support \(language)."
    }
    let tag = locale.identifier(.bcp47)
    let transcriber = FaceclawLiveTranscriber.transcriber(locale)
    guard await AssetInventory.status(forModules: [transcriber]) == .installed else {
      return "The \(tag) speech recognition model is not downloaded."
    }
    await FaceclawLiveTranscriber.keepReserved(locale)
    guard let source = FaceclawLiveTranscriber.pcmFormat,
          let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber], considering: source) else {
      return "No audio format for \(tag) speech recognition (is its model installed?)."
    }
    // The analyzer never converts input itself. No priming: it would shift converted audio later
    // than its start time.
    let converter: AVAudioConverter? = format == source ? nil : AVAudioConverter(from: source, to: format)
    if format != source && converter == nil { return "Cannot convert the glasses' audio for \(tag) speech recognition." }
    converter?.primeMethod = .none
    let analyzer = SpeechAnalyzer(modules: [transcriber],
                                  options: SpeechAnalyzer.Options(priority: .userInitiated, modelRetention: .lingering))
    let (stream, input) = AsyncStream.makeStream(of: AnalyzerInput.self)
    let results = Task.detached(priority: .userInitiated) { [self] in await read(transcriber) }
    do {
      try await analyzer.prepareToAnalyze(in: format)
      try await analyzer.start(inputSequence: stream)
    } catch {
      results.cancel()
      input.finish()
      await analyzer.cancelAndFinishNow()
      return "Could not start \(tag) speech recognition: \(FaceclawLiveTranscriber.describe(error))"
    }
    FaceclawLiveTranscriber.note("\(tag) running (\(format.sampleRate) Hz, \(converter == nil ? "no conversion" : "converted"))")
    queue.async { [self] in
      guard phase == .starting else {  // cancelled meanwhile
        results.cancel()
        input.finish()
        Task { await analyzer.cancelAndFinishNow() }
        return
      }
      self.analyzer = analyzer
      self.input = input
      self.results = results
      self.format = format
      self.converter = converter
      phase = .running
      post(["kind": "ready", "locale": tag])
      // PCM dropped while starting still advances the clock, as it does for the other session.
      fed = frames(forSourceSamples: skippedSamples)
      for chunk in pending { feed(chunk) }
      pending = []
      pendingBytes = 0
      if finishRequested { beginFinish() }
    }
    return nil
  }

  /// Reports results until the transcriber's stream ends (finished, failed or cancelled).
  private func read(_ transcriber: SpeechTranscriber) async {
    var failure: String?
    do {
      for try await result in transcriber.results {
        guard let event = LiveTranscription.event(result) else { continue }
        let line = FaceclawLiveTranscriber.json(event)
        queue.async { [self] in post(line) }
      }
    } catch is CancellationError {
    } catch {
      failure = FaceclawLiveTranscriber.describe(error)
    }
    // Whoever cancelled this task ends the session (with its own message, e.g. setUp's).
    if Task.isCancelled { return }
    let message = failure
    queue.async { [self] in
      guard phase != .ended else { return }
      if let message { post(error: "Speech recognition failed: \(message)") }
      else if phase != .finishing { post(error: "Speech recognition stopped unexpectedly.") }
      end()
    }
  }

  private func beginFinish() {
    phase = .finishing
    input?.finish()
    let analyzer = self.analyzer
    Task { [self] in
      do {
        try await analyzer?.finalizeAndFinishThroughEndOfInput()
      } catch is CancellationError {
      } catch {
        let message = FaceclawLiveTranscriber.describe(error)
        queue.async { [self] in post(error: "Could not finish speech recognition: \(message)") }
        await analyzer?.cancelAndFinishNow()
      }
    }
    // The results stream ends once finalized (read() then ends the session); this bounds a finalize that hangs.
    queue.asyncAfter(deadline: .now() + 15) { [self] in
      guard phase != .ended else { return }
      FaceclawLiveTranscriber.note("\(language) finalize took over 15 s; ending")
      results?.cancel()
      end()
      if let analyzer { Task { await analyzer.cancelAndFinishNow() } }
    }
  }

  private func end() {
    guard phase != .ended else { return }
    post(["kind": "ended"])
    phase = .ended
    input?.finish()
    input = nil
    analyzer = nil
    results = nil
    converter = nil
    pending = []
    FaceclawLiveTranscriber.forget(handle)
  }

  private func hold(_ pcm: Data) {
    pending.append(pcm)
    pendingBytes += pcm.count
    while pendingBytes > LiveTranscription.maxPendingBytes, !pending.isEmpty {
      let dropped = pending.removeFirst()
      pendingBytes -= dropped.count
      if skippedSamples == 0 { FaceclawLiveTranscriber.note("\(language) still starting after 10 s; dropping the oldest audio") }
      skippedSamples += dropped.count / 2
    }
  }

  private func feed(_ pcm: Data) {
    let count = pcm.count / 2
    guard count > 0, let format, let source = FaceclawLiveTranscriber.pcmFormat,
          let buffer = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: AVAudioFrameCount(count)),
          let samples = buffer.int16ChannelData?[0] else { return }
    buffer.frameLength = AVAudioFrameCount(count)
    pcm.withUnsafeBytes { raw in
      if let from = raw.baseAddress { UnsafeMutableRawPointer(samples).copyMemory(from: from, byteCount: count * 2) }
    }
    guard let converted = convert(buffer) else { return }
    let start = CMTime(value: fed, timescale: CMTimeScale(format.sampleRate))
    fed += Int64(converted.frameLength)
    input?.yield(AnalyzerInput(buffer: converted, bufferStartTime: start))
  }

  /// buffer in the analyzer's format; nil when the converter holds it all back (or fails).
  private func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    guard let converter else { return buffer }
    let ratio = converter.outputFormat.sampleRate / converter.inputFormat.sampleRate
    let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 32
    guard let output = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: capacity) else { return nil }
    var supplied = false
    var error: NSError?
    let status = converter.convert(to: output, error: &error) { _, inputStatus in
      // NoDataNow (not EndOfStream) keeps the converter's state for the next chunk.
      if supplied { inputStatus.pointee = .noDataNow; return nil }
      supplied = true
      inputStatus.pointee = .haveData
      return buffer
    }
    if status == .error {
      FaceclawLiveTranscriber.note("\(language) audio conversion failed: \(error?.localizedDescription ?? "unknown")")
      return nil
    }
    return output.frameLength > 0 ? output : nil
  }

  private func frames(forSourceSamples samples: Int) -> Int64 {
    guard let format else { return 0 }
    return Int64((Double(samples) * format.sampleRate / 16_000).rounded())
  }

  /// Sends an event (on queue); nothing follows ended.
  private func post(_ event: [String: Any]) { post(FaceclawLiveTranscriber.json(event)) }

  private func post(_ line: String) {
    guard phase != .ended else { return }
    let events = self.events
    DispatchQueue.main.async { events(line) }
  }

  private func post(error message: String) {
    FaceclawLiveTranscriber.note("\(language): \(message)")
    post(["kind": "error", "message": message])
  }

  /// A result as an event: volatile results are partials (an empty one revokes the last), and an
  /// empty final (no speech) is skipped.
  private static func event(_ result: SpeechTranscriber.Result) -> [String: Any]? {
    let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
    if result.isFinal && text.isEmpty { return nil }
    var confidences: [Double] = []
    var start = Double.infinity, end = -Double.infinity
    for run in result.text.runs {
      if let confidence = run.transcriptionConfidence { confidences.append(confidence) }
      if let range = run.audioTimeRange {
        start = min(start, range.start.seconds)
        end = max(end, range.end.seconds)
      }
    }
    // Runs without time ranges (or with invalid ones): the result's whole range.
    if !start.isFinite || !end.isFinite {
      start = result.range.start.seconds
      end = result.range.end.seconds
    }
    let conf = confidences.isEmpty ? -1 : confidences.reduce(0, +) / Double(confidences.count)
    return ["kind": result.isFinal ? "final" : "partial", "text": text, "conf": conf.isFinite ? conf : -1,
            "start": start.isFinite ? start : 0, "end": end.isFinite ? end : 0]
  }
}
