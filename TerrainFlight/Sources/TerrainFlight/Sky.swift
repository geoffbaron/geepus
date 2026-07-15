import AppKit
import Foundation
import ModelIO
import SceneKit
import simd

/// Deterministic weather for a seed: wind, cloud coverage, sun height, haze.
struct Weather {
    let windDirection: Double   // radians, direction wind blows TOWARD
    let windSpeed: Double       // m/s
    let coverage: Double        // 0...1 cloud coverage
    let sunElevation: Double    // 0...1 for MDLSkyCubeTexture
    let turbidity: Double

    init(seed: UInt64) {
        var rng = SplitMix64(state: seed &* 0x9E37_79B9 &+ 17)
        func unit() -> Double { Double(rng.next() % 100_000) / 100_000 }
        windDirection = unit() * 2 * .pi
        windSpeed = 2.0 + unit() * 7.0
        coverage = 0.25 + unit() * 0.55
        sunElevation = 0.62 + unit() * 0.16
        turbidity = 0.12 + unit() * 0.12
    }

    var windVector: SIMD3<Double> {
        SIMD3(sin(windDirection), 0, cos(windDirection)) * windSpeed
    }

    /// Compass direction the wind blows FROM, for the HUD.
    var windFromDegrees: Int {
        var deg = atan2(-sin(windDirection), -cos(windDirection)) * 180 / .pi
        if deg < 0 { deg += 360 }
        return Int(deg.rounded()) % 360
    }
}

enum SkyBuilder {
    /// The color where sky meets sea — fog uses exactly this for a seamless horizon.
    static let horizonColor = SIMD3<Double>(0.80, 0.85, 0.91)

    /// Hand-rolled gradient sky cubemap with a sun glow, used for both the
    /// background and image-based lighting. Returns the sun (light) direction.
    @discardableResult
    static func apply(to scene: SCNScene, weather: Weather) -> SIMD3<Float> {
        let elevation = 0.35 + weather.sunElevation * 0.6   // radians above horizon
        let azimuth = 2.2
        let sunLightDir = SIMD3<Double>(
            -cos(elevation) * sin(azimuth),
            -sin(elevation),
            -cos(elevation) * cos(azimuth)
        )
        let faces = makeSkyCube(sunPos: -sunLightDir, haze: weather.turbidity)
        scene.background.contents = faces
        scene.lightingEnvironment.contents = faces
        scene.lightingEnvironment.intensity = 1.0
        return SIMD3<Float>(simd_normalize(sunLightDir))
    }

    private static func skyColor(dir: SIMD3<Double>, sunPos: SIMD3<Double>, haze: Double) -> SIMD3<Double> {
        let zenith = SIMD3<Double>(0.16, 0.36, 0.72)
        let ground = SIMD3<Double>(0.52, 0.57, 0.63)
        let el = asin(min(max(dir.y, -1), 1))

        var c: SIMD3<Double>
        if el >= 0 {
            // Haze thickens toward the horizon; more turbidity = whiter sky.
            let t = pow(sin(el), 0.58 - 0.25 * haze)
            c = simd_mix(horizonColor, zenith, SIMD3(repeating: t))
        } else {
            c = simd_mix(horizonColor, ground, SIMD3(repeating: min(1, -el * 2.5)))
        }

        // Sun disc + halo.
        let d = max(simd_dot(simd_normalize(dir), simd_normalize(sunPos)), 0)
        c += SIMD3(1.0, 0.97, 0.88) * (pow(d, 900) * 1.6 + pow(d, 12) * 0.10)
        return simd_clamp(c, SIMD3(repeating: 0), SIMD3(repeating: 1))
    }

    /// Render the 6 cube faces ([+X,-X,+Y,-Y,+Z,-Z]) per-pixel by view direction.
    private static func makeSkyCube(sunPos: SIMD3<Double>, haze: Double, size: Int = 256) -> [NSImage] {
        // Face axes: (normal, uAxis, vAxis) with v running down the image.
        let axes: [(SIMD3<Double>, SIMD3<Double>, SIMD3<Double>)] = [
            (SIMD3(1, 0, 0), SIMD3(0, 0, -1), SIMD3(0, -1, 0)),
            (SIMD3(-1, 0, 0), SIMD3(0, 0, 1), SIMD3(0, -1, 0)),
            (SIMD3(0, 1, 0), SIMD3(1, 0, 0), SIMD3(0, 0, 1)),
            (SIMD3(0, -1, 0), SIMD3(1, 0, 0), SIMD3(0, 0, -1)),
            (SIMD3(0, 0, 1), SIMD3(1, 0, 0), SIMD3(0, -1, 0)),
            (SIMD3(0, 0, -1), SIMD3(-1, 0, 0), SIMD3(0, -1, 0)),
        ]
        return axes.map { n, u, v in
            var pixels = [UInt8](repeating: 255, count: size * size * 4)
            for py in 0..<size {
                for px in 0..<size {
                    let fu = (Double(px) + 0.5) / Double(size) * 2 - 1
                    let fv = (Double(py) + 0.5) / Double(size) * 2 - 1
                    let dir = simd_normalize(n + u * fu + v * fv)
                    let c = skyColor(dir: dir, sunPos: sunPos, haze: haze)
                    let o = (py * size + px) * 4
                    pixels[o] = UInt8(c.x * 255)
                    pixels[o + 1] = UInt8(c.y * 255)
                    pixels[o + 2] = UInt8(c.z * 255)
                }
            }
            let cg = pixels.withUnsafeMutableBytes { buf -> CGImage? in
                guard let ctx = CGContext(
                    data: buf.baseAddress, width: size, height: size,
                    bitsPerComponent: 8, bytesPerRow: size * 4,
                    space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
                ) else { return nil }
                return ctx.makeImage()
            }
            guard let image = cg else { return NSImage(size: NSSize(width: 1, height: 1)) }
            return NSImage(cgImage: image, size: NSSize(width: size, height: size))
        }
    }
}

/// Streamed field of billboard cumulus clusters, deterministic per seed+cell.
final class CloudField {
    let root = SCNNode()
    private let seed: UInt64
    private let coverage: Double
    private let wind: SIMD3<Double>
    private var loaded = [ChunkKey: SCNNode]()
    private let cell = 5200.0
    private let radius = 3

    private static let puffImages = [makePuffImage(seed: 20_260_713), makePuffImage(seed: 998_877)]

    init(seed: UInt64, coverage: Double, wind: SIMD3<Double>) {
        self.seed = seed
        self.coverage = coverage
        self.wind = wind
    }

    func update(around p: SIMD3<Double>) {
        let pcx = Int(floor(p.x / cell))
        let pcz = Int(floor(p.z / cell))
        for dz in -radius...radius {
            for dx in -radius...radius {
                let key = ChunkKey(cx: pcx + dx, cz: pcz + dz)
                if loaded[key] == nil {
                    let node = buildCell(key)
                    node.opacity = 0
                    root.addChildNode(node)
                    node.runAction(.fadeIn(duration: 2.0))
                    loaded[key] = node
                }
            }
        }
        for (key, node) in loaded {
            if abs(key.cx - pcx) > radius + 1 || abs(key.cz - pcz) > radius + 1 {
                node.removeFromParentNode()
                loaded[key] = nil
            }
        }
    }

    private func buildCell(_ key: ChunkKey) -> SCNNode {
        let cellNode = SCNNode()
        var rng = SplitMix64(state: seed ^ (UInt64(bitPattern: Int64(key.cx)) &* 0x9E37) ^ (UInt64(bitPattern: Int64(key.cz)) &* 0x85EB_CA6B))
        func unit() -> Double { Double(rng.next() % 100_000) / 100_000 }

        let count = Int((coverage * 5.5).rounded()) + (unit() < coverage ? 1 : 0)
        for _ in 0..<count {
            let cloud = SCNNode()
            let cx = Double(key.cx) * cell + unit() * cell
            let cz = Double(key.cz) * cell + unit() * cell
            let cy = 1500.0 + unit() * 1100.0
            let width = 450.0 + unit() * 500.0
            cloud.position = SCNVector3(cx, cy, cz)

            // Volumetric-ish stacking: many puffs, darker flat bottoms,
            // brighter cauliflower tops.
            let puffs = 12 + Int(unit() * 8)
            for _ in 0..<puffs {
                let px = (unit() - 0.5) * width
                let py = (unit() * unit() - 0.25) * width * 0.34
                let pz = (unit() - 0.5) * width * 0.7
                let size = width * (0.30 + unit() * 0.28)

                let plane = SCNPlane(width: size, height: size * 0.60)
                let mat = SCNMaterial()
                mat.diffuse.contents = CloudField.puffImages[Int(rng.next() % 2)]
                mat.lightingModel = .constant
                mat.isDoubleSided = true
                mat.writesToDepthBuffer = false
                mat.blendMode = .alpha
                let bright = 0.70 + 0.30 * min(max((py / (width * 0.17) + 1) / 2, 0), 1)
                mat.multiply.contents = NSColor(white: bright, alpha: 1)
                plane.firstMaterial = mat

                let puff = SCNNode(geometry: plane)
                puff.position = SCNVector3(px, py, pz)
                puff.constraints = [SCNBillboardConstraint()]
                puff.renderingOrder = 90
                puff.opacity = 0.72 + unit() * 0.2
                puff.castsShadow = false
                cloud.addChildNode(puff)
            }
            // Clouds drift with the wind, forever.
            cloud.runAction(.repeatForever(.move(by: SCNVector3(wind.x * 60, 0, wind.z * 60), duration: 60)))
            cellNode.addChildNode(cloud)
        }

        // A sparse cirrus veil far above the cumulus layer.
        let cirrusCount = unit() < 0.7 ? 1 + Int(unit() * 2) : 0
        for _ in 0..<cirrusCount {
            let plane = SCNPlane(width: 1800 + unit() * 1400, height: 800 + unit() * 700)
            let mat = SCNMaterial()
            mat.diffuse.contents = CloudField.puffImages[Int(rng.next() % 2)]
            mat.lightingModel = .constant
            mat.isDoubleSided = true
            mat.writesToDepthBuffer = false
            mat.blendMode = .alpha
            plane.firstMaterial = mat
            let cirrus = SCNNode(geometry: plane)
            cirrus.position = SCNVector3(
                Double(key.cx) * cell + unit() * cell,
                4600 + unit() * 900,
                Double(key.cz) * cell + unit() * cell
            )
            cirrus.eulerAngles = SCNVector3(-Double.pi / 2, unit() * .pi, 0)
            cirrus.opacity = 0.10 + unit() * 0.10
            cirrus.renderingOrder = 85
            cirrus.castsShadow = false
            cellNode.addChildNode(cirrus)
        }
        return cellNode
    }

    /// Soft cumulus sprite: many overlapping radial gradients inside an oval falloff.
    private static func makePuffImage(seed: UInt64) -> NSImage {
        let size = 256
        let image = NSImage(size: NSSize(width: size, height: size))
        image.lockFocus()
        guard let ctx = NSGraphicsContext.current?.cgContext else {
            image.unlockFocus()
            return image
        }
        var rng = SplitMix64(state: seed)
        func unit() -> CGFloat { CGFloat(rng.next() % 100_000) / 100_000 }
        let space = CGColorSpaceCreateDeviceRGB()
        for _ in 0..<90 {
            let angle = unit() * 2 * .pi
            let dist = unit()
            let cx = 128 + cos(angle) * dist * 72
            let cy = 128 + sin(angle) * dist * 40
            let radius = 22 + unit() * 44
            let alpha = 0.06 + 0.06 * (1 - dist)
            let colors = [
                CGColor(red: 1, green: 1, blue: 1, alpha: alpha),
                CGColor(red: 1, green: 1, blue: 1, alpha: 0),
            ] as CFArray
            if let grad = CGGradient(colorsSpace: space, colors: colors, locations: [0, 1]) {
                ctx.drawRadialGradient(
                    grad,
                    startCenter: CGPoint(x: cx, y: cy), startRadius: 0,
                    endCenter: CGPoint(x: cx, y: cy), endRadius: radius,
                    options: []
                )
            }
        }
        image.unlockFocus()
        return image
    }
}
