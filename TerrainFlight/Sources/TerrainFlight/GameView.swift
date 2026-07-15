import AppKit
import SceneKit

/// SCNView subclass that tracks held keys for the flight controls.
final class GameView: SCNView {
    private let lock = NSLock()
    private var pressed = Set<UInt16>()
    var onKeyTap: ((UInt16) -> Void)?
    var onClick: ((CGPoint) -> Void)?

    override var acceptsFirstResponder: Bool { true }

    override func mouseDown(with event: NSEvent) {
        // View coords share the SKScene's bottom-left origin under resizeFill.
        onClick?(convert(event.locationInWindow, from: nil))
        window?.makeFirstResponder(self)
    }

    override func keyDown(with event: NSEvent) {
        if event.modifierFlags.contains(.command) {
            super.keyDown(with: event)
            return
        }
        lock.lock()
        let isRepeat = pressed.contains(event.keyCode)
        pressed.insert(event.keyCode)
        lock.unlock()
        if !isRepeat { onKeyTap?(event.keyCode) }
    }

    override func keyUp(with event: NSEvent) {
        lock.lock()
        pressed.remove(event.keyCode)
        lock.unlock()
    }

    func isDown(_ code: UInt16) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return pressed.contains(code)
    }
}

enum Key {
    static let left: UInt16 = 123
    static let right: UInt16 = 124
    static let down: UInt16 = 125
    static let up: UInt16 = 126
    static let a: UInt16 = 0
    static let s: UInt16 = 1
    static let d: UInt16 = 2
    static let h: UInt16 = 4
    static let r: UInt16 = 15
    static let w: UInt16 = 13
    static let g: UInt16 = 5
    static let c: UInt16 = 8
    static let v: UInt16 = 9
    static let space: UInt16 = 49
}
