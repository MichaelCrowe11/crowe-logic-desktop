import Foundation
import Capacitor
import AVFoundation

/// Read-aloud on the phone, over Apple's speech synthesiser.
///
/// The web speechSynthesis in WKWebView only reaches the compact voices, so a
/// reply read through it sounds like a 2010 GPS. This plugin picks the best
/// voice installed for the language (premium, then enhanced, then default) and
/// never a Personal Voice or a novelty voice: a reply is never read in a real
/// person's cloned voice. Nothing leaves the device and nothing is billed.
///
/// JS contract (window.Capacitor.Plugins.CroweVoice):
///   voices({language?})           -> { voices: [{ id, name, quality, language }], best: id | null }
///   speak({text, voice?, rate?})  -> resolves once speech has started
///   stop()                        -> resolves once stopped
///   event "speakState"            -> { status: "started" | "ended" | "cancelled" }
@objc(CroweVoice)
public class CroweVoice: CAPPlugin, CAPBridgedPlugin, AVSpeechSynthesizerDelegate {
    public let identifier = "CroweVoice"
    public let jsName = "CroweVoice"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "voices", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]

    private let synth = AVSpeechSynthesizer()

    override public func load() {
        synth.delegate = self
    }

    /// Voices a reply may be read in: the language's own, minus anything built
    /// from a real person's voice or meant as a joke.
    private func usable(_ language: String) -> [AVSpeechSynthesisVoice] {
        let prefix = String(language.prefix(2))
        return AVSpeechSynthesisVoice.speechVoices().filter { v in
            guard v.language.hasPrefix(prefix) else { return false }
            if #available(iOS 17.0, *) {
                if v.voiceTraits.contains(.isPersonalVoice) || v.voiceTraits.contains(.isNoveltyVoice) { return false }
            }
            return true
        }
    }

    private func rank(_ v: AVSpeechSynthesisVoice, _ language: String) -> Int {
        var score = 0
        if #available(iOS 16.0, *), v.quality == .premium { score += 300 }
        if v.quality == .enhanced { score += 200 }
        if v.language == language { score += 10 }
        return score
    }

    private func qualityName(_ v: AVSpeechSynthesisVoice) -> String {
        if #available(iOS 16.0, *), v.quality == .premium { return "premium" }
        return v.quality == .enhanced ? "enhanced" : "default"
    }

    private func best(_ language: String) -> AVSpeechSynthesisVoice? {
        usable(language).max { rank($0, language) < rank($1, language) }
    }

    @objc func voices(_ call: CAPPluginCall) {
        let language = call.getString("language") ?? AVSpeechSynthesisVoice.currentLanguageCode()
        let list = usable(language).sorted { rank($0, language) > rank($1, language) }
        call.resolve([
            "voices": list.map { ["id": $0.identifier, "name": $0.name, "quality": qualityName($0), "language": $0.language] },
            "best": best(language)?.identifier ?? NSNull(),
        ])
    }

    @objc func speak(_ call: CAPPluginCall) {
        guard let text = call.getString("text"), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            call.reject("nothing to read")
            return
        }
        DispatchQueue.main.async {
            if self.synth.isSpeaking { self.synth.stopSpeaking(at: .immediate) }
            let language = call.getString("language") ?? AVSpeechSynthesisVoice.currentLanguageCode()
            let utterance = AVSpeechUtterance(string: text)
            // A requested voice is honoured only if it is one this plugin would offer.
            if let id = call.getString("voice"), let v = self.usable(language).first(where: { $0.identifier == id }) {
                utterance.voice = v
            } else {
                utterance.voice = self.best(language)
            }
            utterance.rate = Float(call.getDouble("rate") ?? Double(AVSpeechUtteranceDefaultSpeechRate))
            let session = AVAudioSession.sharedInstance()
            try? session.setCategory(.playback, mode: .spokenAudio, options: .duckOthers)
            try? session.setActive(true)
            self.synth.speak(utterance)
            call.resolve(["voice": utterance.voice?.name ?? ""])
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.synth.stopSpeaking(at: .immediate)
            call.resolve()
        }
    }

    private func release() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        notifyListeners("speakState", data: ["status": "started"])
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        release()
        notifyListeners("speakState", data: ["status": "ended"])
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        release()
        notifyListeners("speakState", data: ["status": "cancelled"])
    }
}
