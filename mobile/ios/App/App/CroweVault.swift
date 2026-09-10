import Foundation
import Capacitor
import Security

/// Keychain storage for the phone's secrets.
///
/// The bridge kept its config, refresh token included, in Capacitor
/// Preferences, which is NSUserDefaults: a plist in the app sandbox that rides
/// along in backups. The Keychain is where a refresh token belongs. This plugin
/// is a plain generic-password store, scoped to this device and readable after
/// first unlock so a background refresh still works. Registered from
/// CroweBridgeViewController like CroweSpeech; the JS side (vault.js) routes
/// the "config" record here and leaves everything else in Preferences.
///
/// JS contract (window.Capacitor.Plugins.CroweVault):
///   get({key})         -> { value: String | null }
///   set({key, value})  -> {}
///   remove({key})      -> {}
@objc(CroweVault)
public class CroweVault: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CroweVault"
    public let jsName = "CroweVault"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
    ]

    private let service = "com.crowelogic.mobile.vault"

    private func query(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else { call.reject("key is required"); return }
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { call.resolve(["value": NSNull()]); return }
        guard status == errSecSuccess, let data = out as? Data, let value = String(data: data, encoding: .utf8) else {
            call.reject("keychain read failed: \(status)")
            return
        }
        call.resolve(["value": value])
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else { call.reject("key is required"); return }
        let value = call.getString("value") ?? ""
        let data = Data(value.utf8)
        var q = query(key)
        let update: [String: Any] = [kSecValueData as String: data]
        var status = SecItemUpdate(q as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            q[kSecValueData as String] = data
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(q as CFDictionary, nil)
        }
        guard status == errSecSuccess else { call.reject("keychain write failed: \(status)"); return }
        call.resolve()
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else { call.reject("key is required"); return }
        let status = SecItemDelete(query(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { call.reject("keychain delete failed: \(status)"); return }
        call.resolve()
    }
}
