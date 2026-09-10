import UIKit
import Capacitor

/// The storyboard's root controller. Capacitor registers packaged plugins from
/// capacitor.config.json on its own; plugins that live in this target are
/// registered here, once the bridge exists.
class CroweBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(CroweSpeech())
    }
}
