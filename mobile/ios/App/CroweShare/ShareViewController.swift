import UIKit
import UniformTypeIdentifiers

/// The Share Extension. Any app's share sheet can hand Crowe Logic a link,
/// some text or a photo. The extension writes what it received into the App
/// Group's UserDefaults under the key the Capacitor Preferences plugin reads
/// for the "share" entry (suite group.com.crowelogic.mobile), opens the app on
/// com.crowelogic.mobile://share, and closes. The web layer (share-inbox.js)
/// picks the note up on launch or on return to the foreground and drops it
/// into the composer, with a photo going to CroweLM Vision the same way the
/// camera button does. No UI of its own: the sheet appears, the app opens.
final class ShareViewController: UIViewController {
    static let group = "group.com.crowelogic.mobile"
    static let key = "CapacitorStorage.share"
    static let maxImageSide: CGFloat = 1280

    private var handled = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !handled else { return }
        handled = true
        Task { await handle() }
    }

    private func handle() async {
        var note: [String: Any] = ["at": Int(Date().timeIntervalSince1970 * 1000)]
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        for item in items {
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                   let url = await load(provider, UTType.url.identifier) as? URL {
                    note["url"] = url.absoluteString
                } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier),
                          let jpeg = await loadImage(provider) {
                    note["image"] = "data:image/jpeg;base64," + jpeg.base64EncodedString()
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                          let text = await load(provider, UTType.plainText.identifier) as? String {
                    note["text"] = text
                }
            }
            if note["text"] == nil, let body = item.attributedContentText?.string, !body.isEmpty {
                note["text"] = body
            }
        }
        if note.count > 1,
           let data = try? JSONSerialization.data(withJSONObject: note),
           let json = String(data: data, encoding: .utf8) {
            UserDefaults(suiteName: Self.group)?.set(json, forKey: Self.key)
            openHost(URL(string: "com.crowelogic.mobile://share")!)
        }
        extensionContext?.completeRequest(returningItems: nil)
    }

    private func load(_ provider: NSItemProvider, _ type: String) async -> NSSecureCoding? {
        await withCheckedContinuation { cont in
            provider.loadItem(forTypeIdentifier: type, options: nil) { item, _ in cont.resume(returning: item) }
        }
    }

    /// Photos arrive as a file URL, a UIImage or raw Data depending on the app.
    /// Whatever it is, the note carries a JPEG no larger than 1280 px a side,
    /// the same size the camera button sends.
    private func loadImage(_ provider: NSItemProvider) async -> Data? {
        let item = await load(provider, UTType.image.identifier)
        var image: UIImage?
        if let url = item as? URL, let data = try? Data(contentsOf: url) { image = UIImage(data: data) }
        else if let ui = item as? UIImage { image = ui }
        else if let data = item as? Data { image = UIImage(data: data) }
        guard let source = image else { return nil }
        let longest = max(source.size.width, source.size.height)
        let scale = longest > Self.maxImageSide ? Self.maxImageSide / longest : 1
        let size = CGSize(width: source.size.width * scale, height: source.size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: size, format: { let f = UIGraphicsImageRendererFormat(); f.scale = 1; return f }())
        let small = renderer.image { _ in source.draw(in: CGRect(origin: .zero, size: size)) }
        return small.jpegData(compressionQuality: 0.82)
    }

    /// Extensions cannot call UIApplication.shared.open. Walking the responder
    /// chain to the host's UIApplication and asking it to open the URL is the
    /// established way a share extension hands off to its containing app.
    private func openHost(_ url: URL) {
        let selector = sel_registerName("openURL:")
        var responder: UIResponder? = self
        while let current = responder {
            if current.responds(to: selector) {
                _ = current.perform(selector, with: url)
                return
            }
            responder = current.next
        }
    }
}
