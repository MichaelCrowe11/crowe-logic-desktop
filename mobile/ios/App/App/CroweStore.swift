import Foundation
import Capacitor
import StoreKit

/// The App Store storefront this install buys from, which is the signal Apple's
/// United States link-out carve-out turns on (guideline 3.1.1 as amended after
/// Epic v. Apple). The device locale is not: plenty of people outside the US run
/// en-US, and a US account can run any language. The bridge shows a web upgrade
/// only when this answers "USA", and treats nil, an error, or no answer as no.
@objc(CroweStore)
public class CroweStore: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CroweStore"
    public let jsName = "CroweStore"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "storefront", returnType: CAPPluginReturnPromise),
    ]

    /// { countryCode: "USA" } (ISO 3166-1 alpha-3), or { countryCode: "" } when
    /// StoreKit has no storefront, which the simulator often reports.
    @objc func storefront(_ call: CAPPluginCall) {
        Task {
            let code = await Storefront.current?.countryCode ?? ""
            CAPLog.print("CroweStore storefront:", code.isEmpty ? "(none)" : code)
            call.resolve(["countryCode": code])
        }
    }
}
