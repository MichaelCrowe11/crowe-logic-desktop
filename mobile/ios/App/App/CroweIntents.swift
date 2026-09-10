import Foundation
import AppIntents

/// Siri and Shortcuts entry points.
///
/// Each intent opens the app and leaves a note for the web layer in the same
/// UserDefaults the Capacitor Preferences plugin reads ("CapacitorStorage.<key>"
/// in the standard suite). The bridge reads and clears `intent` on launch and on
/// every return to the foreground, then dispatches it to the UI. No URL scheme,
/// no extra plugin: a phone that was already open just picks the note up.
enum PendingIntent {
    static let key = "CapacitorStorage.intent"

    static func write(kind: String, text: String) {
        let note: [String: Any] = ["kind": kind, "text": text, "at": Int(Date().timeIntervalSince1970 * 1000)]
        if let data = try? JSONSerialization.data(withJSONObject: note), let json = String(data: data, encoding: .utf8) {
            UserDefaults.standard.set(json, forKey: key)
        }
    }
}

@available(iOS 16.0, *)
struct AskCroweLogicIntent: AppIntent {
    static var title: LocalizedStringResource = "Ask Crowe Logic"
    static var description = IntentDescription("Send a question to Crowe Logic and see the reply.")
    static var openAppWhenRun: Bool = true

    @Parameter(title: "Question", requestValueDialog: "What do you want to ask?")
    var question: String

    static var parameterSummary: some ParameterSummary {
        Summary("Ask Crowe Logic \(\.$question)")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        PendingIntent.write(kind: "ask", text: question)
        return .result()
    }
}

@available(iOS 16.0, *)
struct LogBlockIntent: AppIntent {
    static var title: LocalizedStringResource = "Log a block"
    static var description = IntentDescription("Open the grow log on a new block, with your note ready.")
    static var openAppWhenRun: Bool = true

    @Parameter(title: "Note", default: "")
    var note: String

    static var parameterSummary: some ParameterSummary {
        Summary("Log a block \(\.$note)")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        PendingIntent.write(kind: "log-block", text: note)
        return .result()
    }
}

@available(iOS 16.0, *)
struct CroweShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskCroweLogicIntent(),
            phrases: ["Ask \(.applicationName)", "Ask \(.applicationName) a question", "Ask \(.applicationName) about my grow"],
            shortTitle: "Ask",
            systemImageName: "bubble.left.and.text.bubble.right"
        )
        AppShortcut(
            intent: LogBlockIntent(),
            phrases: ["Log a block in \(.applicationName)", "New block in \(.applicationName)"],
            shortTitle: "Log a block",
            systemImageName: "square.stack.3d.up"
        )
    }
}
