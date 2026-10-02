import UIKit
import Capacitor

/// The phone's frame, drawn by UIKit instead of HTML.
///
/// The web tab bar is still built by mobile-ui.js and still owns what each tab
/// does; native-chrome.js mirrors it into this UITabBar and, on a tap, clicks
/// the matching web tab. So the bar gets the system look (Liquid Glass on
/// iOS 26, SF Symbols, Dynamic Type, VoiceOver) with no second copy of the
/// navigation logic. Haptics ride along because they need the same bridge.
///
/// JS contract (window.Capacitor.Plugins.CroweChrome):
///   setTabs({items: [{id, label, symbol}], current?, tint?: "r,g,b"}) -> { height }  (points, incl. the home-indicator inset)
///   setCurrent({id})                                   -> resolves
///   setHidden({hidden})                                -> resolves
///   haptic({style: "selection"|"light"|"medium"|"success"|"warning"|"error"})
///   event "tabSelected"                                -> { id }
@objc(CroweChrome)
public class CroweChrome: CAPPlugin, CAPBridgedPlugin, UITabBarDelegate {
    public let identifier = "CroweChrome"
    public let jsName = "CroweChrome"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setTabs", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setCurrent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setHidden", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "haptic", returnType: CAPPluginReturnPromise),
    ]

    private var bar: UITabBar?
    private var ids: [String] = []

    private func ensureBar() -> UITabBar? {
        if let bar = bar { return bar }
        guard let host = bridge?.viewController?.view else { return nil }
        let tabBar = UITabBar()
        tabBar.delegate = self
        tabBar.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(tabBar)
        NSLayoutConstraint.activate([
            tabBar.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            tabBar.trailingAnchor.constraint(equalTo: host.trailingAnchor),
            tabBar.bottomAnchor.constraint(equalTo: host.bottomAnchor),
        ])
        bar = tabBar
        return tabBar
    }

    private func height(_ tabBar: UITabBar) -> CGFloat {
        tabBar.superview?.layoutIfNeeded()
        return tabBar.frame.height
    }

    @objc func setTabs(_ call: CAPPluginCall) {
        let items = call.getArray("items", JSObject.self) ?? []
        let current = call.getString("current")
        let tint = (call.getString("tint") ?? "").split(separator: ",").compactMap { Double($0) }
        DispatchQueue.main.async {
            guard let tabBar = self.ensureBar() else { call.reject("no host view"); return }
            if tint.count == 3 {
                tabBar.tintColor = UIColor(red: tint[0] / 255, green: tint[1] / 255, blue: tint[2] / 255, alpha: 1)
            }
            self.ids = items.compactMap { $0["id"] as? String }
            let barItems: [UITabBarItem] = items.enumerated().map { index, item in
                let symbol = item["symbol"] as? String ?? "circle"
                let image = UIImage(systemName: symbol) ?? UIImage(systemName: "circle")
                let tabItem = UITabBarItem(title: item["label"] as? String, image: image, tag: index)
                tabItem.accessibilityIdentifier = item["id"] as? String
                return tabItem
            }
            tabBar.setItems(barItems, animated: false)
            if let current = current, let i = self.ids.firstIndex(of: current) { tabBar.selectedItem = barItems[i] }
            call.resolve(["height": self.height(tabBar)])
        }
    }

    @objc func setCurrent(_ call: CAPPluginCall) {
        let id = call.getString("id")
        DispatchQueue.main.async {
            guard let tabBar = self.bar else { call.resolve(); return }
            if let id = id, let i = self.ids.firstIndex(of: id), let items = tabBar.items, i < items.count {
                tabBar.selectedItem = items[i]
            } else {
                tabBar.selectedItem = nil
            }
            call.resolve()
        }
    }

    @objc func setHidden(_ call: CAPPluginCall) {
        let hidden = call.getBool("hidden") ?? false
        DispatchQueue.main.async {
            self.bar?.isHidden = hidden
            call.resolve()
        }
    }

    @objc func haptic(_ call: CAPPluginCall) {
        let style = call.getString("style") ?? "selection"
        DispatchQueue.main.async {
            switch style {
            case "light": UIImpactFeedbackGenerator(style: .light).impactOccurred()
            case "medium": UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
            case "warning": UINotificationFeedbackGenerator().notificationOccurred(.warning)
            case "error": UINotificationFeedbackGenerator().notificationOccurred(.error)
            default: UISelectionFeedbackGenerator().selectionChanged()
            }
            call.resolve()
        }
    }

    public func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
        guard item.tag >= 0 && item.tag < ids.count else { return }
        UISelectionFeedbackGenerator().selectionChanged()
        notifyListeners("tabSelected", data: ["id": ids[item.tag]])
    }
}
