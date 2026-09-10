import Foundation
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
///   available({language?})          -> { available: Bool }
///   checkPermissions()              -> { speechRecognition: "granted" | "denied" | "prompt" }
///   requestPermissions()            -> same shape, after asking for speech + microphone
///   start({language?, partialResults?}) -> resolves once listening; events follow
///   stop()                          -> resolves once stopped
///   event "partialResults"          -> { matches: [String] }  (cumulative transcript, best first)
///   event "listeningState"          -> { status: "started" | "stopped" }
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

    @objc func available(_ call: CAPPluginCall) {
        let locale = Locale(identifier: call.getString("language") ?? "en-US")
        let recognizer = SFSpeechRecognizer(locale: locale)
        call.resolve(["available": recognizer?.isAvailable ?? false])
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
            if self.task != nil { self.teardown(notify: false) }
            let locale = Locale(identifier: call.getString("language") ?? "en-US")
            guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else {
                call.reject("speech recognition is not available")
                return
            }
            self.recognizer = recognizer
            let session = AVAudioSession.sharedInstance()
            do {
                try session.setCategory(.record, mode: .measurement, options: .duckOthers)
                try session.setActive(true, options: .notifyOthersOnDeactivation)
            } catch {
                call.reject("audio session: \(error.localizedDescription)")
                return
            }
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = call.getBool("partialResults") ?? true
            self.request = request

            let input = self.audioEngine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.channelCount > 0 else {
                self.teardown(notify: false)
                call.reject("no microphone input")
                return
            }
            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                self?.request?.append(buffer)
            }
            self.audioEngine.prepare()
            do {
                try self.audioEngine.start()
            } catch {
                self.teardown(notify: false)
                call.reject("audio engine: \(error.localizedDescription)")
                return
            }
            self.notifyListeners("listeningState", data: ["status": "started"])
            self.task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                guard let self = self else { return }
                if let result = result {
                    var matches = result.transcriptions.map { $0.formattedString }
                    if matches.isEmpty { matches = [result.bestTranscription.formattedString] }
                    self.notifyListeners("partialResults", data: ["matches": matches])
                    if result.isFinal { self.teardown(notify: true) }
                }
                if error != nil { self.teardown(notify: true) }
            }
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.teardown(notify: true)
            call.resolve()
        }
    }

    /// Idempotent. The recogniser's callback and stop() both land here; only the
    /// first caller finds a task to tear down and only it announces "stopped".
    private func teardown(notify: Bool) {
        let work = {
            guard self.task != nil || self.audioEngine.isRunning else { return }
            if self.audioEngine.isRunning { self.audioEngine.stop() }
            self.audioEngine.inputNode.removeTap(onBus: 0)
            self.request?.endAudio()
            let task = self.task
            self.task = nil
            self.request = nil
            task?.cancel()
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            if notify { self.notifyListeners("listeningState", data: ["status": "stopped"]) }
        }
        if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
    }
}
