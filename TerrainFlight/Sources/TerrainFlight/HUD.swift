import Foundation
import SpriteKit

final class HUD {
    let scene: SKScene
    private let stats = SKLabelNode(fontNamed: "Menlo-Bold")
    private let combatStats = SKLabelNode(fontNamed: "Menlo-Bold")
    private let message = SKLabelNode(fontNamed: "Menlo-Bold")
    private let help = SKLabelNode(fontNamed: "Menlo")
    private let crosshair = SKLabelNode(fontNamed: "Menlo")
    private var messageClearTime: TimeInterval = 0

    private var modeButton: SKShapeNode!
    private var viewButton: SKShapeNode!
    private var planeButton: SKShapeNode!
    private var respawnButton: SKShapeNode!
    private var modeButtonLabel: SKLabelNode!
    private var viewButtonLabel: SKLabelNode!
    private var planeButtonLabel: SKLabelNode!
    private var respawnButtonLabel: SKLabelNode!

    static let modeButtonName = "btn-mode"
    static let viewButtonName = "btn-view"
    static let planeButtonName = "btn-plane"
    static let respawnButtonName = "btn-respawn"

    // Radar minimap (bottom-right, heading-up).
    private let radarRoot = SKNode()
    private let radarLand = SKSpriteNode(color: .clear, size: CGSize(width: 156, height: 156))
    private let radarNorth = SKLabelNode(fontNamed: "Menlo-Bold")
    private var banditDots: [SKShapeNode] = []
    private let radarRadius: CGFloat = 78
    /// World meters shown from center to rim; must match the land texture span.
    static let radarRange = 4000.0

    init(size: CGSize) {
        scene = SKScene(size: size)
        scene.scaleMode = .resizeFill
        scene.backgroundColor = .clear

        stats.fontSize = 15
        stats.fontColor = SKColor(white: 1, alpha: 0.92)
        stats.horizontalAlignmentMode = .left
        stats.verticalAlignmentMode = .top
        scene.addChild(stats)

        combatStats.fontSize = 15
        combatStats.fontColor = SKColor(red: 1, green: 0.55, blue: 0.35, alpha: 0.95)
        combatStats.horizontalAlignmentMode = .left
        combatStats.verticalAlignmentMode = .top
        scene.addChild(combatStats)

        message.fontSize = 26
        message.fontColor = SKColor(red: 1, green: 0.85, blue: 0.3, alpha: 1)
        message.horizontalAlignmentMode = .center
        message.verticalAlignmentMode = .center
        scene.addChild(message)

        crosshair.text = "+"
        crosshair.fontSize = 13
        crosshair.fontColor = SKColor(red: 1, green: 0.9, blue: 0.5, alpha: 0.6)
        crosshair.horizontalAlignmentMode = .center
        crosshair.verticalAlignmentMode = .center
        crosshair.isHidden = true
        scene.addChild(crosshair)

        help.fontSize = 12
        help.fontColor = SKColor(white: 1, alpha: 0.75)
        help.horizontalAlignmentMode = .left
        help.verticalAlignmentMode = .bottom
        help.numberOfLines = 0
        help.text = """
        ARROWS pitch/roll   A/D rudder   W/S throttle   SPACE fire   G mode   V plane   C view   R respawn   H hide help
        Down arrow pulls up. Bank to turn. Don't fly slow. G toggles WW2 dogfight, V cycles plane, C cockpit view.
        """
        scene.addChild(help)

        (modeButton, modeButtonLabel) = HUD.makeButton(named: HUD.modeButtonName)
        (viewButton, viewButtonLabel) = HUD.makeButton(named: HUD.viewButtonName)
        (planeButton, planeButtonLabel) = HUD.makeButton(named: HUD.planeButtonName)
        (respawnButton, respawnButtonLabel) = HUD.makeButton(named: HUD.respawnButtonName)
        respawnButtonLabel.text = "RESPAWN ↺"
        scene.addChild(modeButton)
        scene.addChild(viewButton)
        scene.addChild(planeButton)
        scene.addChild(respawnButton)
        setButtons(mode: "FREE FLIGHT", view: "CHASE", plane: "CESSNA")

        buildRadar()
    }

    private func buildRadar() {
        let bg = SKShapeNode(circleOfRadius: radarRadius)
        bg.fillColor = SKColor(white: 0, alpha: 0.45)
        bg.strokeColor = SKColor(white: 1, alpha: 0.35)
        bg.lineWidth = 1
        radarRoot.addChild(bg)

        let mask = SKShapeNode(circleOfRadius: radarRadius - 2)
        mask.fillColor = .white
        mask.strokeColor = .clear
        let crop = SKCropNode()
        crop.maskNode = mask
        radarLand.alpha = 0.9
        crop.addChild(radarLand)
        radarRoot.addChild(crop)

        let ring = SKShapeNode(circleOfRadius: radarRadius / 2)
        ring.fillColor = .clear
        ring.strokeColor = SKColor(white: 1, alpha: 0.15)
        radarRoot.addChild(ring)

        // Player marker: small upward triangle at center.
        let path = CGMutablePath()
        path.move(to: CGPoint(x: 0, y: 7))
        path.addLine(to: CGPoint(x: -5, y: -5))
        path.addLine(to: CGPoint(x: 5, y: -5))
        path.closeSubpath()
        let player = SKShapeNode(path: path)
        player.fillColor = SKColor(white: 1, alpha: 0.95)
        player.strokeColor = .clear
        player.zPosition = 3
        radarRoot.addChild(player)

        radarNorth.text = "N"
        radarNorth.fontSize = 11
        radarNorth.fontColor = SKColor(white: 1, alpha: 0.8)
        radarNorth.verticalAlignmentMode = .center
        radarNorth.horizontalAlignmentMode = .center
        radarNorth.zPosition = 3
        radarRoot.addChild(radarNorth)

        scene.addChild(radarRoot)
    }

    func setRadarLand(_ texture: SKTexture) {
        texture.filteringMode = .linear
        radarLand.texture = texture
    }

    // MARK: - In-sky target markers

    struct TargetMarker {
        let x: Double
        let y: Double
        let inFront: Bool
        let distance: Double
    }

    private struct MarkerNodes {
        let root: SKNode
        let diamond: SKShapeNode
        let arrow: SKShapeNode
        let label: SKLabelNode
    }

    private var markers: [MarkerNodes] = []

    private func makeMarker() -> MarkerNodes {
        let color = SKColor(red: 1, green: 0.32, blue: 0.25, alpha: 0.92)
        let root = SKNode()
        root.zPosition = 5

        let dPath = CGMutablePath()
        dPath.move(to: CGPoint(x: 0, y: 13))
        dPath.addLine(to: CGPoint(x: 9, y: 0))
        dPath.addLine(to: CGPoint(x: 0, y: -13))
        dPath.addLine(to: CGPoint(x: -9, y: 0))
        dPath.closeSubpath()
        let diamond = SKShapeNode(path: dPath)
        diamond.strokeColor = color
        diamond.fillColor = .clear
        diamond.lineWidth = 1.5
        root.addChild(diamond)

        let aPath = CGMutablePath()
        aPath.move(to: CGPoint(x: 15, y: 0))
        aPath.addLine(to: CGPoint(x: -6, y: 8))
        aPath.addLine(to: CGPoint(x: -6, y: -8))
        aPath.closeSubpath()
        let arrow = SKShapeNode(path: aPath)
        arrow.strokeColor = .clear
        arrow.fillColor = color
        root.addChild(arrow)

        let label = SKLabelNode(fontNamed: "Menlo-Bold")
        label.fontSize = 10
        label.fontColor = color
        label.verticalAlignmentMode = .center
        label.horizontalAlignmentMode = .center
        root.addChild(label)

        scene.addChild(root)
        return MarkerNodes(root: root, diamond: diamond, arrow: arrow, label: label)
    }

    /// Diamond brackets over visible bandits; edge arrows toward the rest.
    func updateTargetMarkers(_ items: [TargetMarker]) {
        while markers.count < items.count { markers.append(makeMarker()) }
        let size = scene.size
        let cx = size.width / 2, cy = size.height / 2

        for (i, m) in markers.enumerated() {
            guard i < items.count else {
                m.root.isHidden = true
                continue
            }
            m.root.isHidden = false
            let item = items[i]
            let distText = item.distance < 1000
                ? "\(Int(item.distance))m"
                : String(format: "%.1fkm", item.distance / 1000)
            m.label.text = distText

            let inset: CGFloat = 30
            var px = CGFloat(item.x), py = CGFloat(item.y)
            let onScreen = item.inFront
                && px > inset && px < size.width - inset
                && py > inset && py < size.height - inset

            if onScreen {
                m.diamond.isHidden = false
                m.arrow.isHidden = true
                m.root.position = CGPoint(x: px, y: py)
                m.root.zRotation = 0
                m.label.zRotation = 0
                m.label.position = CGPoint(x: 0, y: -25)
            } else {
                // Behind the camera projects mirrored — flip it back.
                if !item.inFront {
                    px = 2 * cx - px
                    py = 2 * cy - py
                }
                var dx = px - cx, dy = py - cy
                let len = max(sqrt(dx * dx + dy * dy), 0.001)
                dx /= len
                dy /= len
                let margin: CGFloat = 48
                let tx = dx != 0 ? (cx - margin) / abs(dx) : .greatestFiniteMagnitude
                let ty = dy != 0 ? (cy - margin) / abs(dy) : .greatestFiniteMagnitude
                let t = min(tx, ty)
                m.diamond.isHidden = true
                m.arrow.isHidden = false
                m.root.position = CGPoint(x: cx + dx * t, y: cy + dy * t)
                m.root.zRotation = atan2(dy, dx)
                // Keep the label upright, tucked toward screen center.
                m.label.position = CGPoint(x: -26, y: 0)
                m.label.zRotation = -m.root.zRotation
            }
        }
    }

    /// Heading-up radar: rotate the land layer and plot bandits relative to the
    /// player. Offsets are (east, north) in meters; far contacts clamp to the rim.
    func updateRadar(headingRad: Double, banditOffsets: [(Double, Double)]) {
        radarLand.zRotation = CGFloat(headingRad)
        radarNorth.position = CGPoint(
            x: (radarRadius - 12) * CGFloat(-sin(headingRad)),
            y: (radarRadius - 12) * CGFloat(cos(headingRad))
        )

        while banditDots.count < banditOffsets.count {
            let dot = SKShapeNode(circleOfRadius: 4)
            dot.fillColor = SKColor(red: 1, green: 0.25, blue: 0.2, alpha: 0.95)
            dot.strokeColor = .clear
            dot.zPosition = 4
            banditDots.append(dot)
            radarRoot.addChild(dot)
        }
        for (i, dot) in banditDots.enumerated() {
            guard i < banditOffsets.count else {
                dot.isHidden = true
                continue
            }
            dot.isHidden = false
            let (e, n) = banditOffsets[i]
            var x = e * cos(headingRad) - n * sin(headingRad)
            var y = e * sin(headingRad) + n * cos(headingRad)
            let scale = Double(radarRadius - 6) / HUD.radarRange
            x *= scale
            y *= scale
            let len = (x * x + y * y).squareRoot()
            let maxLen = Double(radarRadius - 8)
            if len > maxLen {
                x *= maxLen / len
                y *= maxLen / len
            }
            dot.position = CGPoint(x: x, y: y)
        }
    }

    private static func makeButton(named name: String) -> (SKShapeNode, SKLabelNode) {
        let box = SKShapeNode(rectOf: CGSize(width: 190, height: 26), cornerRadius: 6)
        box.fillColor = SKColor(white: 0, alpha: 0.45)
        box.strokeColor = SKColor(white: 1, alpha: 0.35)
        box.lineWidth = 1
        box.name = name
        let label = SKLabelNode(fontNamed: "Menlo-Bold")
        label.fontSize = 12
        label.fontColor = SKColor(white: 1, alpha: 0.9)
        label.verticalAlignmentMode = .center
        label.horizontalAlignmentMode = .center
        label.name = name
        box.addChild(label)
        return (box, label)
    }

    /// Reflect the current mode/view/plane on the clickable buttons.
    func setButtons(mode: String, view: String, plane: String) {
        modeButtonLabel.text = "MODE: \(mode) ⇄"
        viewButtonLabel.text = "VIEW: \(view) ⇄"
        planeButtonLabel.text = "PLANE: \(plane) ⇄"
    }

    /// Returns the button name at a click point (scene coords), if any.
    func buttonName(at point: CGPoint) -> String? {
        for node in scene.nodes(at: point) {
            if let name = node.name, name.hasPrefix("btn-") { return name }
        }
        return nil
    }

    var showHelp = true

    func update(speed: Double, altitude: Double, ground: Double, heading: Int, throttle: Double, wind: String, combat: String?, time: TimeInterval) {
        let size = scene.size
        stats.position = CGPoint(x: 16, y: size.height - 14)
        combatStats.position = CGPoint(x: 16, y: size.height - 38)
        message.position = CGPoint(x: size.width / 2, y: size.height * 0.62)
        crosshair.position = CGPoint(x: size.width / 2, y: size.height / 2)
        modeButton.position = CGPoint(x: size.width - 113, y: size.height - 24)
        planeButton.position = CGPoint(x: size.width - 113, y: size.height - 56)
        viewButton.position = CGPoint(x: size.width - 113, y: size.height - 88)
        respawnButton.position = CGPoint(x: size.width - 113, y: size.height - 120)
        radarRoot.position = CGPoint(x: size.width - 102, y: 102)
        help.position = CGPoint(x: 16, y: 12)
        help.isHidden = !showHelp

        stats.text = String(
            format: "SPD %3.0f m/s   ALT %5.0f m   AGL %5.0f m   HDG %03d   THR %3.0f%%   %@",
            speed, altitude, max(0, altitude - ground), heading, throttle * 100, wind
        )
        combatStats.text = combat ?? ""
        crosshair.isHidden = combat == nil
        if time > messageClearTime { message.text = "" }
    }

    func flash(_ text: String, at time: TimeInterval, for duration: TimeInterval = 3) {
        message.text = text
        messageClearTime = time + duration
    }
}
