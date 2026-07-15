import AppKit
import SceneKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var controller: GameController!

    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = CommandLine.arguments.dropFirst()
        let seed = args.compactMap { UInt64($0) }.first ?? 30
        let startInDogfight = args.contains("--dogfight")

        let rect = NSRect(x: 0, y: 0, width: 1280, height: 800)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Terrain Flight — seed \(seed)"
        window.center()

        let view = GameView(frame: rect)
        controller = GameController(seed: seed, viewSize: rect.size)
        controller.view = view

        view.scene = controller.scene
        view.delegate = controller
        view.pointOfView = controller.cameraNode
        view.overlaySKScene = controller.hud.scene
        view.antialiasingMode = .multisampling4X
        view.preferredFramesPerSecond = 60
        view.rendersContinuously = true
        view.isPlaying = true
        view.onKeyTap = { [weak self] code in self?.controller.handleKeyTap(code) }
        view.onClick = { [weak self] point in self?.controller.handleClick(at: point) }

        window.contentView = view
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(view)
        // Cooperative activation: don't yank focus if the user is mid-typing elsewhere.
        NSApp.activate()

        if args.contains("--aimbot") { controller.combat.aimTest = true }
        if startInDogfight || controller.combat.aimTest { controller.setMode(.dogfight) }
        if args.contains("--cockpit") { controller.cockpitView = true }
        if args.contains("--stats") { view.showsStatistics = true }
        if args.contains("--jet") { controller.setVehicle(.jet) }
        if args.contains("--spitfire") { controller.setVehicle(.spitfire) }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

// Minimal menu so Cmd+Q works.
func makeMenu() -> NSMenu {
    let main = NSMenu()
    let appItem = NSMenuItem()
    main.addItem(appItem)
    let appMenu = NSMenu()
    appMenu.addItem(NSMenuItem(title: "Quit Terrain Flight", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    appItem.submenu = appMenu
    return main
}

setvbuf(stdout, nil, _IOLBF, 0)

let app = NSApplication.shared
app.setActivationPolicy(.regular)
app.mainMenu = makeMenu()
let delegate = AppDelegate()
app.delegate = delegate
app.run()
