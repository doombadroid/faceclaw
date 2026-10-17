import AlarmKit
import Foundation
import SwiftUI

// AlarmKit is Swift-only and iOS 26+. This exposes the calls alarms.ios.ts needs as ObjC class
// methods; nsld.sh feeds the generated <product>-Swift.h to the metadata generator.
// AlarmKit is weak-linked (build.xcconfig), so every use sits behind #available.
// Ids are UUID strings; callbacks run on the main thread.
@objc(FaceclawAlarmKit) public final class FaceclawAlarmKit: NSObject {
  private static var tail: Task<Void, Never>?
  private static var watcher: Task<Void, Never>?

  // One AlarmKit call at a time, in call order, so a cancel never overtakes the schedule before it.
  private static func enqueue(_ body: @escaping () async -> Void) {
    let previous = tail
    tail = Task { _ = await previous?.value; await body() }
  }

  @objc(isAvailable) public static func isAvailable() -> Bool {
    if #available(iOS 26, *) { return true }
    return false
  }

  /// 0 not determined, 1 denied, 2 authorized, -1 below iOS 26.
  @objc(authorizationState) public static func authorizationState() -> Int {
    guard #available(iOS 26, *) else { return -1 }
    return code(AlarmManager.shared.authorizationState)
  }

  @objc(requestAuthorization:) public static func requestAuthorization(_ done: @escaping (Int) -> Void) {
    guard #available(iOS 26, *) else { return done(-1) }
    enqueue {
      let state = (try? await AlarmManager.shared.requestAuthorization()).map { FaceclawAlarmKit.code($0) } ?? 1
      DispatchQueue.main.async { done(state) }
    }
  }

  /// A one-shot alarm with only a Stop button at atMs (Unix ms); done gets nil or the error.
  @objc(scheduleAlarm:atMs:title:completion:)
  public static func scheduleAlarm(_ id: String, atMs: Double, title: String, completion done: @escaping (String?) -> Void) {
    guard #available(iOS 26, *) else { return done("AlarmKit needs iOS 26") }
    guard let uuid = UUID(uuidString: id) else { return done("bad alarm id \(id)") }
    enqueue {
      var failure: String?
      do {
        // Deprecated in 26.1 for the title-only init, which a 26.0 SDK lacks.
        let alert = AlarmPresentation.Alert(title: LocalizedStringResource(stringLiteral: title),
                                            stopButton: AlarmButton(text: "Stop", textColor: .white, systemImageName: "stop.circle"))
        let attributes = AlarmAttributes<Meta>(presentation: AlarmPresentation(alert: alert), tintColor: .orange)
        let configuration = AlarmManager.AlarmConfiguration<Meta>.alarm(schedule: .fixed(Date(timeIntervalSince1970: atMs / 1000)), attributes: attributes)
        _ = try await AlarmManager.shared.schedule(id: uuid, configuration: configuration)
      } catch {
        failure = "\(error)"
      }
      DispatchQueue.main.async { done(failure) }
    }
  }

  @objc(cancelAlarm:) public static func cancelAlarm(_ id: String) {
    guard #available(iOS 26, *), let uuid = UUID(uuidString: id) else { return }
    enqueue { _ = try? AlarmManager.shared.cancel(id: uuid) }
  }

  /// Comma-separated lowercase ids AlarmKit still holds: a one-shot alarm drops out once it fired and was stopped.
  @objc(alarmIds) public static func alarmIds() -> String {
    guard #available(iOS 26, *) else { return "" }
    return list((try? AlarmManager.shared.alarms) ?? [])
  }

  /// handler gets alarmIds() after every change; a new call replaces the previous handler.
  @objc(observeAlarms:) public static func observeAlarms(_ handler: @escaping (String) -> Void) {
    guard #available(iOS 26, *) else { return }
    watcher?.cancel()
    watcher = Task {
      for await alarms in AlarmManager.shared.alarmUpdates {
        let ids = FaceclawAlarmKit.list(alarms)
        DispatchQueue.main.async { handler(ids) }
      }
    }
  }

  @available(iOS 26, *)
  private static func code(_ state: AlarmManager.AuthorizationState) -> Int {
    switch state {
    case .notDetermined: return 0
    case .authorized: return 2
    default: return 1
    }
  }

  @available(iOS 26, *)
  private static func list(_ alarms: [Alarm]) -> String {
    alarms.map { $0.id.uuidString.lowercased() }.joined(separator: ",")
  }
}

@available(iOS 26, *)
private struct Meta: AlarmMetadata {}
