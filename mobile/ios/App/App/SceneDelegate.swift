import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let sceneWindow = UIWindow(windowScene: windowScene)
        // Keep the custom bridge that registers the vault, speech and native chrome.
        sceneWindow.rootViewController = CroweBridgeViewController()
        window = sceneWindow
        // Register cold-start URL delivery before the bridge first appears.
        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
        sceneWindow.makeKeyAndVisible()
    }

    func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: contexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
