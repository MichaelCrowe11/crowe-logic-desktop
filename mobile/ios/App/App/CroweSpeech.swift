import Foundation
import UIKit
import Capacitor
import Speech
import AVFoundation

/// Dictation for the phone, over Apple's speech recogniser.
///
/// WKWebView exposes `webkitSpeechRecognition` but the recogniser behind it never
/// starts (WebKit bug 239816), so the web handler cannot be used on iOS. This
/// plugin lives in the app target and is registered by CroweBridgeViewController;
/// it is not a package, so it needs no manifest entry and survives `cap sync`.
///
/// JS contract (window.Capacitor.Plugins.CroweSpeech):
///   available({language?})          -> { available: Bool, sessionIds: true }
///   checkPermissions()              -> { speechRecognition: "granted" | "denied" | "prompt" }
///   requestPermissions()            -> same shape, after asking for speech + microphone
///   start({language?, partialResults?, sessionId?}) -> resolves once listening; events follow
///   stop({sessionId?})               -> resolves once that session stops
///   event "partialResults"          -> { matches: [String], sessionId: String }
///   event "listeningState"          -> { status: "started" | "stopped", sessionId: String }
@objc(CroweSpeech)
public class CroweSpeech: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CroweSpeech"
    public let jsName = "CroweSpeech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]

    private let audioEngine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var sessionId: String?
    private var generation: UUID?
    private var tapInstalled = false

    /// The microphone does not stay with an app in the background, and a
    /// recognition task left running there ends in an error the composer would
    /// read as a failure. Leaving the app ends dictation the same way the stop
    /// button does, so the button is not left lit for a session that is gone.
    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(appWillResignActive),
                                               name: UIApplication.willResignActiveNotification, object: nil)
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    @objc private func appWillResignActive() { teardown(notify: true) }

    @objc func available(_ call: CAPPluginCall) {
        let locale = Locale(identifier: call.getString("language") ?? "en-US")
        let recognizer = SFSpeechRecognizer(locale: locale)
        call.resolve(["available": recognizer?.isAvailable ?? false, "sessionIds": true])
    }

    @objc override public func checkPermissions(_ call: CAPPluginCall) {
        call.resolve(["speechRecognition": permissionState()])
    }

    @objc override public func requestPermissions(_ call: CAPPluginCall) {
        SFSpeechRecognizer.requestAuthorization { auth in
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                DispatchQueue.main.async {
                    let ok = auth == .authorized && granted
                    call.resolve(["speechRecognition": ok ? "granted" : self.permissionState()])
                }
            }
        }
    }

    private func permissionState() -> String {
        let auth = SFSpeechRecognizer.authorizationStatus()
        let mic = AVAudioSession.sharedInstance().recordPermission
        if auth == .authorized && mic == .granted { return "granted" }
        if auth == .notDetermined || mic == .undetermined { return "prompt" }
        return "denied"
    }

    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.generation == nil else {
                call.reject("another dictation session is still active")
                return
            }
            // Asked for by the page first; checked here too so a denied or
            // revoked permission is a plain rejection, not an engine error.
            guard self.permissionState() == "granted" else {
                call.reject("microphone or speech recognition permission not granted", "PERMISSION_DENIED")
                return
            }
            let locale = Locale(identifier: call.getString("language") ?? "en-US")
            guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else {
                call.reject("speech recognition is not available")
                return
            }
            let generation = UUID()
            let sessionId = call.getString("sessionId") ?? UUID().uuidString
            self.generation = generation
            self.sessionId = sessionId
            self.recognizer = recognizer
            let session = AVAudioSession.sharedInstance()
            do {
                try session.setCategory(.record, mode: .measurement, options: .duckOthers)
                try session.setActive(true, options: .notifyOthersOnDeactivation)
            } catch {
                self.teardown(notify: false)
                call.reject("audio session: \(error.localizedDescription)")
                return
            }
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = call.getBool("partialResults") ?? true
            // On-device when this phone and language can, so dictation does not
            // leave the device; Apple's server otherwise, as the usage string says.
            if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
            self.request = request

            let input = self.audioEngine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.channelCount > 0 else {
                self.teardown(notify: false)
                call.reject("no microphone input")
                return
            }
            if self.tapInstalled { input.removeTap(onBus: 0); self.tapInstalled = false }
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                request.append(buffer)
            }
            self.tapInstalled = true
            self.audioEngine.prepare()
            do {
                try self.audioEngine.start()
            } catch {
                self.teardown(notify: false)
                call.reject("audio engine: \(error.localizedDescription)")
                return
            }
            self.notifyListeners("listeningState", data: ["status": "started", "sessionId": sessionId])
            self.task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                DispatchQueue.main.async {
                    guard let self = self, self.generation == generation else { return }
                    if let result = result {
                        var matches = result.transcriptions.map { $0.formattedString }
                        if matches.isEmpty { matches = [result.bestTranscription.formattedString] }
                        self.notifyListeners("partialResults", data: ["matches": matches, "sessionId": sessionId])
                        if result.isFinal { self.teardown(notify: true) }
                    }
                    if error != nil && self.generation == generation { self.teardown(notify: true) }
                }
            }
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let requested = call.getString("sessionId"), requested != self.sessionId {
                call.resolve()
                return
            }
            self.teardown(notify: true)
            call.resolve()
        }
    }

    /// Idempotent. The recogniser's callback and stop() both land here; only the
    /// first caller finds a task to tear down and only it announces "stopped".
    private func teardown(notify: Bool) {
        let work = {
            guard self.generation != nil else { return }
            let sessionId = self.sessionId ?? ""
            self.generation = nil
            self.sessionId = nil
            if self.audioEngine.isRunning { self.audioEngine.stop() }
            if self.tapInstalled { self.audioEngine.inputNode.removeTap(onBus: 0); self.tapInstalled = false }
            self.request?.endAudio()
            let task = self.task
            self.task = nil
            self.request = nil
            task?.cancel()
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            if notify { self.notifyListeners("listeningState", data: ["status": "stopped", "sessionId": sessionId]) }
        }
        if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
    }
}
