import Foundation
import SceneKit
import simd

/// Indexed mesh with smooth accumulated normals — enough to skin cross-sections
/// into fuselages and airfoils without any asset files.
private struct MeshData {
    var positions: [SIMD3<Float>] = []
    var indices: [UInt32] = []

    mutating func addVertex(_ p: SIMD3<Float>) -> UInt32 {
        positions.append(p)
        return UInt32(positions.count - 1)
    }

    mutating func addTri(_ a: UInt32, _ b: UInt32, _ c: UInt32) {
        indices.append(contentsOf: [a, b, c])
    }

    /// Skin a sequence of same-count closed rings into a tube; optionally cap ends.
    mutating func skin(rings: [[SIMD3<Float>]], capStart: Bool, capEnd: Bool) {
        let m = rings[0].count
        var ringStarts: [UInt32] = []
        for ring in rings {
            ringStarts.append(UInt32(positions.count))
            positions.append(contentsOf: ring)
        }
        for r in 0..<(rings.count - 1) {
            let a = ringStarts[r], b = ringStarts[r + 1]
            for i in 0..<m {
                let j = (i + 1) % m
                addTri(a + UInt32(i), b + UInt32(i), a + UInt32(j))
                addTri(a + UInt32(j), b + UInt32(i), b + UInt32(j))
            }
        }
        if capStart {
            let ring = rings[0]
            let c = addVertex(ring.reduce(.zero, +) / Float(m))
            let s = ringStarts[0]
            for i in 0..<m { addTri(c, s + UInt32(i), s + UInt32((i + 1) % m)) }
        }
        if capEnd {
            let ring = rings[rings.count - 1]
            let c = addVertex(ring.reduce(.zero, +) / Float(m))
            let s = ringStarts[rings.count - 1]
            for i in 0..<m { addTri(c, s + UInt32((i + 1) % m), s + UInt32(i)) }
        }
    }

    func geometry(material: SCNMaterial) -> SCNGeometry {
        // Smooth normals: accumulate face normals per vertex.
        var normals = [SIMD3<Float>](repeating: .zero, count: positions.count)
        var t = 0
        while t < indices.count {
            let ia = Int(indices[t]), ib = Int(indices[t + 1]), ic = Int(indices[t + 2])
            let n = simd_cross(positions[ib] - positions[ia], positions[ic] - positions[ia])
            normals[ia] += n
            normals[ib] += n
            normals[ic] += n
            t += 3
        }
        normals = normals.map { simd_length($0) > 1e-8 ? simd_normalize($0) : SIMD3(0, 1, 0) }

        let pos = SCNGeometrySource(
            data: positions.withUnsafeBytes { Data($0) },
            semantic: .vertex, vectorCount: positions.count,
            usesFloatComponents: true, componentsPerVector: 3,
            bytesPerComponent: 4, dataOffset: 0, dataStride: MemoryLayout<SIMD3<Float>>.stride
        )
        let nrm = SCNGeometrySource(
            data: normals.withUnsafeBytes { Data($0) },
            semantic: .normal, vectorCount: normals.count,
            usesFloatComponents: true, componentsPerVector: 3,
            bytesPerComponent: 4, dataOffset: 0, dataStride: MemoryLayout<SIMD3<Float>>.stride
        )
        let element = SCNGeometryElement(indices: indices, primitiveType: .triangles)
        let g = SCNGeometry(sources: [pos, nrm], elements: [element])
        g.firstMaterial = material
        return g
    }
}

enum AircraftModel {

    private static func paint(_ r: Double, _ g: Double, _ b: Double, roughness: Double = 0.38, metal: Double = 0.05) -> SCNMaterial {
        let m = SCNMaterial()
        m.lightingModel = .physicallyBased
        m.diffuse.contents = NSColor(red: r, green: g, blue: b, alpha: 1)
        m.roughness.contents = roughness as NSNumber
        m.metalness.contents = metal as NSNumber
        m.isDoubleSided = true
        return m
    }

    private static var white: SCNMaterial { paint(0.92, 0.91, 0.88) }
    private static var red: SCNMaterial { paint(0.72, 0.10, 0.10) }
    private static var dark: SCNMaterial { paint(0.10, 0.10, 0.11, roughness: 0.5) }
    private static var glass: SCNMaterial {
        let m = paint(0.12, 0.18, 0.24, roughness: 0.05, metal: 0.4)
        m.transparency = 0.75
        return m
    }

    /// Cross-section ring of the fuselage: ellipse with vertical offset.
    private static func fuselageRing(z: Float, rx: Float, ry: Float, yOff: Float, count: Int = 16) -> [SIMD3<Float>] {
        (0..<count).map { i in
            let a = Float(i) / Float(count) * 2 * .pi
            return SIMD3(rx * sin(a), ry * cos(a) + yOff, z)
        }
    }

    /// Closed airfoil loop: leading edge → over the top → trailing edge → under.
    /// `axis` maps (thickness, chordwise) into 3D around the given leading edge.
    private static func airfoil(le: SIMD3<Float>, chord: Float, thicknessDir: SIMD3<Float>, chordDir: SIMD3<Float>) -> [SIMD3<Float>] {
        let profile: [(Float, Float)] = [
            (0.00, 0.000),
            (0.03, 0.032), (0.12, 0.058), (0.30, 0.068), (0.55, 0.052), (0.80, 0.026), (1.00, 0.002),
            (0.80, -0.008), (0.55, -0.014), (0.30, -0.018), (0.12, -0.016), (0.03, -0.010),
        ]
        return profile.map { f, t in le + chordDir * (f * chord) + thicknessDir * (t * chord) }
    }

    static func makeNode() -> SCNNode {
        let root = SCNNode()

        // --- Fuselage: nose cowl → cabin → tapered tail cone (forward is -Z) ---
        var fuselage = MeshData()
        let stations: [(Float, Float, Float, Float)] = [
            (-3.30, 0.14, 0.14, 0.00),
            (-3.05, 0.44, 0.46, 0.02),
            (-2.35, 0.54, 0.58, 0.06),
            (-1.45, 0.58, 0.68, 0.10),
            (-0.40, 0.58, 0.70, 0.12),
            (0.60, 0.50, 0.60, 0.14),
            (1.80, 0.30, 0.36, 0.24),
            (3.00, 0.16, 0.20, 0.36),
            (3.60, 0.06, 0.15, 0.44),
        ]
        fuselage.skin(
            rings: stations.map { fuselageRing(z: $0.0, rx: $0.1, ry: $0.2, yOff: $0.3) },
            capStart: true, capEnd: true
        )
        root.addChildNode(SCNNode(geometry: fuselage.geometry(material: white)))

        // --- High wing with taper, dihedral, and a hint of sweep ---
        let wingY: Float = 0.80
        for side in [Float(1), Float(-1)] {
            var wing = MeshData()
            let rootRing = airfoil(le: SIMD3(side * 0.25, wingY, -1.20), chord: 1.55, thicknessDir: SIMD3(0, 1, 0), chordDir: SIMD3(0, 0, 1))
            let midRing = airfoil(le: SIMD3(side * 2.9, wingY + 0.10, -1.12), chord: 1.35, thicknessDir: SIMD3(0, 1, 0), chordDir: SIMD3(0, 0, 1))
            let tipRing = airfoil(le: SIMD3(side * 5.3, wingY + 0.22, -1.00), chord: 0.95, thicknessDir: SIMD3(0, 1, 0), chordDir: SIMD3(0, 0, 1))
            wing.skin(rings: [rootRing, midRing, tipRing], capStart: true, capEnd: false)
            root.addChildNode(SCNNode(geometry: wing.geometry(material: white)))

            // Red wingtip cap.
            var tip = MeshData()
            let tipEnd = airfoil(le: SIMD3(side * 5.55, wingY + 0.24, -0.96), chord: 0.7, thicknessDir: SIMD3(0, 1, 0), chordDir: SIMD3(0, 0, 1))
            tip.skin(rings: [tipRing, tipEnd], capStart: false, capEnd: true)
            root.addChildNode(SCNNode(geometry: tip.geometry(material: red)))

            // Wing strut.
            let strut = SCNNode(geometry: SCNCylinder(radius: 0.045, height: 1))
            strut.geometry?.firstMaterial = white
            let from = SIMD3<Float>(side * 0.55, -0.30, -0.65)
            let to = SIMD3<Float>(side * 2.6, wingY + 0.02, -0.75)
            placeCylinder(strut, from: from, to: to)
            root.addChildNode(strut)
        }

        // --- Tailplane ---
        for side in [Float(1), Float(-1)] {
            var tail = MeshData()
            let rootRing = airfoil(le: SIMD3(side * 0.10, 0.42, 2.85), chord: 0.90, thicknessDir: SIMD3(0, 1, 0), chordDir: SIMD3(0, 0, 1))
            let tipRing = airfoil(le: SIMD3(side * 1.75, 0.44, 3.05), chord: 0.60, thicknessDir: SIMD3(0, 1, 0), chordDir: SIMD3(0, 0, 1))
            tail.skin(rings: [rootRing, tipRing], capStart: true, capEnd: true)
            root.addChildNode(SCNNode(geometry: tail.geometry(material: white)))
        }

        // --- Vertical fin (red, swept) ---
        var fin = MeshData()
        let finRoot = airfoil(le: SIMD3(0, 0.45, 2.55), chord: 1.25, thicknessDir: SIMD3(1, 0, 0), chordDir: SIMD3(0, 0, 1))
        let finTip = airfoil(le: SIMD3(0, 1.75, 3.15), chord: 0.65, thicknessDir: SIMD3(1, 0, 0), chordDir: SIMD3(0, 0, 1))
        fin.skin(rings: [finRoot, finTip], capStart: true, capEnd: true)
        root.addChildNode(SCNNode(geometry: fin.geometry(material: red)))

        // --- Red fuselage accent stripe through the cabin ---
        let stripe = SCNNode(geometry: SCNBox(width: 1.19, height: 0.15, length: 2.7, chamferRadius: 0.05))
        stripe.geometry?.firstMaterial = red
        stripe.position = SCNVector3(0, 0.05, -0.6)
        root.addChildNode(stripe)

        // --- Windshield and side glass ---
        let windshield = SCNNode(geometry: SCNBox(width: 1.0, height: 0.55, length: 0.06, chamferRadius: 0.02))
        windshield.geometry?.firstMaterial = glass
        windshield.position = SCNVector3(0, 0.62, -1.32)
        windshield.eulerAngles.x = -0.55
        root.addChildNode(windshield)
        for side in [CGFloat(1), CGFloat(-1)] {
            let win = SCNNode(geometry: SCNBox(width: 0.05, height: 0.34, length: 1.05, chamferRadius: 0.02))
            win.geometry?.firstMaterial = glass
            win.position = SCNVector3(side * 0.57, 0.42, -0.55)
            root.addChildNode(win)
        }

        // --- Spinner + propeller ---
        let spinner = SCNNode(geometry: SCNCone(topRadius: 0.02, bottomRadius: 0.16, height: 0.5))
        spinner.geometry?.firstMaterial = red
        spinner.eulerAngles.x = -.pi / 2
        spinner.position = SCNVector3(0, 0, -3.55)
        root.addChildNode(spinner)

        let hub = SCNNode()
        hub.position = SCNVector3(0, 0, -3.42)
        for k in 0..<2 {
            let blade = SCNNode(geometry: SCNBox(width: 0.14, height: 1.15, length: 0.045, chamferRadius: 0.02))
            blade.geometry?.firstMaterial = dark
            blade.position = SCNVector3(0, k == 0 ? 0.62 : -0.62, 0)
            blade.eulerAngles.y = k == 0 ? 0.35 : -0.35
            hub.addChildNode(blade)
        }
        hub.runAction(.repeatForever(.rotateBy(x: 0, y: 0, z: .pi * 2, duration: 0.08)))
        root.addChildNode(hub)

        // --- Landing gear ---
        for side in [Float(1), Float(-1)] {
            let leg = SCNNode(geometry: SCNCylinder(radius: 0.05, height: 1))
            leg.geometry?.firstMaterial = white
            placeCylinder(leg, from: SIMD3(side * 0.35, -0.55, -0.55), to: SIMD3(side * 1.05, -1.05, -0.55))
            root.addChildNode(leg)
            let wheel = SCNNode(geometry: SCNCylinder(radius: 0.22, height: 0.16))
            wheel.geometry?.firstMaterial = dark
            wheel.eulerAngles.z = .pi / 2
            wheel.position = SCNVector3(CGFloat(side) * 1.08, -1.08, -0.55)
            root.addChildNode(wheel)
        }
        let noseLeg = SCNNode(geometry: SCNCylinder(radius: 0.045, height: 1))
        noseLeg.geometry?.firstMaterial = white
        placeCylinder(noseLeg, from: SIMD3(0, -0.45, -2.45), to: SIMD3(0, -0.95, -2.55))
        root.addChildNode(noseLeg)
        let noseWheel = SCNNode(geometry: SCNCylinder(radius: 0.17, height: 0.14))
        noseWheel.geometry?.firstMaterial = dark
        noseWheel.eulerAngles.z = .pi / 2
        noseWheel.position = SCNVector3(0, -0.98, -2.56)
        root.addChildNode(noseWheel)

        return root
    }

    // MARK: - WW2 fighters

    /// Player fighter: Spitfire-inspired — low elliptical-taper wing, RAF
    /// roundels, dark green over gray.
    static func makeSpitfire() -> SCNNode {
        let root = SCNNode()
        let green = paint(0.20, 0.26, 0.15, roughness: 0.5)
        let underside = paint(0.62, 0.66, 0.68, roughness: 0.5)

        var fuselage = MeshData()
        let stations: [(Float, Float, Float, Float)] = [
            (-3.95, 0.26, 0.26, 0.00),
            (-3.45, 0.50, 0.54, 0.00),
            (-2.20, 0.55, 0.62, 0.02),
            (-0.80, 0.52, 0.60, 0.06),
            (0.50, 0.44, 0.52, 0.10),
            (1.90, 0.28, 0.34, 0.16),
            (3.20, 0.13, 0.22, 0.26),
            (3.90, 0.04, 0.16, 0.32),
        ]
        fuselage.skin(
            rings: stations.map { fuselageRing(z: $0.0, rx: $0.1, ry: $0.2, yOff: $0.3) },
            capStart: true, capEnd: true
        )
        root.addChildNode(SCNNode(geometry: fuselage.geometry(material: green)))

        // Low wing with elliptical-ish taper.
        for side in [Float(1), Float(-1)] {
            var wing = MeshData()
            let rootRing = airfoil(le: SIMD3(side * 0.30, -0.28, -1.45), chord: 2.30, thicknessDir: SIMD3(0, 1, 0), chordDir: SIMD3(0, 0, 1))
            let midRing = airfoil(le: SIMD3(side * 2.8, -0.16, -1.30), chord: 1.85, thicknessDir: SIMD3(0, 1, 0), chordDir: SIMD3(0, 0, 1))
            let outRing = airfoil(le: SIMD3(side * 4.6, -0.06, -1.00), chord: 1.15, thicknessDir: SIMD3(0, 1, 0), chordDir: SIMD3(0, 0, 1))
            let tipRing = airfoil(le: SIMD3(side * 5.35, -0.02, -0.72), chord: 0.45, thicknessDir: SIMD3(0, 1, 0), chordDir: SIMD3(0, 0, 1))
            wing.skin(rings: [rootRing, midRing, outRing, tipRing], capStart: true, capEnd: true)
            root.addChildNode(SCNNode(geometry: wing.geometry(material: green)))

            // RAF roundel: blue/white/red stacked discs on the wing top.
            let colors: [(Double, Double, Double, CGFloat)] = [
                (0.05, 0.15, 0.45, 0.52), (0.92, 0.92, 0.90, 0.34), (0.70, 0.08, 0.08, 0.16),
            ]
            for (i, c) in colors.enumerated() {
                let disc = SCNNode(geometry: SCNCylinder(radius: c.3, height: 0.02))
                disc.geometry?.firstMaterial = paint(c.0, c.1, c.2, roughness: 0.6)
                disc.position = SCNVector3(CGFloat(side) * 3.1, -0.02 + CGFloat(i) * 0.012, -0.35)
                root.addChildNode(disc)
            }
        }

        // Tailplane + fin.
        for side in [Float(1), Float(-1)] {
            var tail = MeshData()
            let r = airfoil(le: SIMD3(side * 0.08, 0.30, 3.05), chord: 0.95, thicknessDir: SIMD3(0, 1, 0), chordDir: SIMD3(0, 0, 1))
            let t = airfoil(le: SIMD3(side * 1.65, 0.32, 3.30), chord: 0.55, thicknessDir: SIMD3(0, 1, 0), chordDir: SIMD3(0, 0, 1))
            tail.skin(rings: [r, t], capStart: true, capEnd: true)
            root.addChildNode(SCNNode(geometry: tail.geometry(material: green)))
        }
        var fin = MeshData()
        fin.skin(rings: [
            airfoil(le: SIMD3(0, 0.32, 2.80), chord: 1.15, thicknessDir: SIMD3(1, 0, 0), chordDir: SIMD3(0, 0, 1)),
            airfoil(le: SIMD3(0, 1.55, 3.25), chord: 0.60, thicknessDir: SIMD3(1, 0, 0), chordDir: SIMD3(0, 0, 1)),
        ], capStart: true, capEnd: true)
        root.addChildNode(SCNNode(geometry: fin.geometry(material: green)))

        // Belly plate hint (light underside).
        let belly = SCNNode(geometry: SCNBox(width: 0.95, height: 0.1, length: 4.6, chamferRadius: 0.05))
        belly.geometry?.firstMaterial = underside
        belly.position = SCNVector3(0, -0.58, -0.3)
        root.addChildNode(belly)

        // Canopy.
        let canopy = SCNNode(geometry: SCNBox(width: 0.66, height: 0.42, length: 1.25, chamferRadius: 0.18))
        canopy.geometry?.firstMaterial = glass
        canopy.position = SCNVector3(0, 0.68, -0.35)
        root.addChildNode(canopy)

        addPropAndSpinner(to: root, spinnerZ: -4.05, spinnerMaterial: dark, bladeLength: 1.35)
        return root
    }

    /// Bandit: Bf 109-inspired — slim gray fuselage, yellow nose, squared wings.
    static func makeBandit() -> SCNNode {
        let root = SCNNode()
        let gray = paint(0.42, 0.45, 0.48, roughness: 0.5)
        let yellow = paint(0.82, 0.65, 0.10, roughness: 0.45)

        // Yellow cowl up front, gray aft — split the fuselage into two skins.
        var nose = MeshData()
        let noseStations: [(Float, Float, Float, Float)] = [
            (-3.75, 0.24, 0.24, 0.00),
            (-3.30, 0.46, 0.50, 0.00),
            (-2.30, 0.50, 0.58, 0.02),
        ]
        nose.skin(rings: noseStations.map { fuselageRing(z: $0.0, rx: $0.1, ry: $0.2, yOff: $0.3) }, capStart: true, capEnd: false)
        root.addChildNode(SCNNode(geometry: nose.geometry(material: yellow)))

        var aft = MeshData()
        let aftStations: [(Float, Float, Float, Float)] = [
            (-2.30, 0.50, 0.58, 0.02),
            (-0.80, 0.48, 0.56, 0.05),
            (0.60, 0.40, 0.48, 0.09),
            (2.00, 0.24, 0.30, 0.16),
            (3.30, 0.10, 0.18, 0.26),
            (3.85, 0.04, 0.13, 0.30),
        ]
        aft.skin(rings: aftStations.map { fuselageRing(z: $0.0, rx: $0.1, ry: $0.2, yOff: $0.3) }, capStart: false, capEnd: true)
        root.addChildNode(SCNNode(geometry: aft.geometry(material: gray)))

        // Squared-off low wings.
        for side in [Float(1), Float(-1)] {
            var wing = MeshData()
            let r = airfoil(le: SIMD3(side * 0.28, -0.24, -1.30), chord: 2.00, thicknessDir: SIMD3(0, 1, 0), chordDir: SIMD3(0, 0, 1))
            let m = airfoil(le: SIMD3(side * 3.2, -0.10, -1.12), chord: 1.55, thicknessDir: SIMD3(0, 1, 0), chordDir: SIMD3(0, 0, 1))
            let t = airfoil(le: SIMD3(side * 4.9, -0.02, -0.95), chord: 1.10, thicknessDir: SIMD3(0, 1, 0), chordDir: SIMD3(0, 0, 1))
            wing.skin(rings: [r, m, t], capStart: true, capEnd: true)
            root.addChildNode(SCNNode(geometry: wing.geometry(material: gray)))

            // Wing cross: white disc under a black disc.
            let white = SCNNode(geometry: SCNCylinder(radius: 0.46, height: 0.02))
            white.geometry?.firstMaterial = paint(0.9, 0.9, 0.88, roughness: 0.6)
            white.position = SCNVector3(CGFloat(side) * 3.2, 0.02, -0.30)
            root.addChildNode(white)
            let black = SCNNode(geometry: SCNCylinder(radius: 0.30, height: 0.025))
            black.geometry?.firstMaterial = paint(0.06, 0.06, 0.06, roughness: 0.6)
            black.position = SCNVector3(CGFloat(side) * 3.2, 0.032, -0.30)
            root.addChildNode(black)
        }

        for side in [Float(1), Float(-1)] {
            var tail = MeshData()
            let r = airfoil(le: SIMD3(side * 0.07, 0.28, 3.00), chord: 0.85, thicknessDir: SIMD3(0, 1, 0), chordDir: SIMD3(0, 0, 1))
            let t = airfoil(le: SIMD3(side * 1.45, 0.30, 3.15), chord: 0.55, thicknessDir: SIMD3(0, 1, 0), chordDir: SIMD3(0, 0, 1))
            tail.skin(rings: [r, t], capStart: true, capEnd: true)
            root.addChildNode(SCNNode(geometry: tail.geometry(material: gray)))
        }
        var fin = MeshData()
        fin.skin(rings: [
            airfoil(le: SIMD3(0, 0.28, 2.85), chord: 1.00, thicknessDir: SIMD3(1, 0, 0), chordDir: SIMD3(0, 0, 1)),
            airfoil(le: SIMD3(0, 1.35, 3.25), chord: 0.55, thicknessDir: SIMD3(1, 0, 0), chordDir: SIMD3(0, 0, 1)),
        ], capStart: true, capEnd: true)
        root.addChildNode(SCNNode(geometry: fin.geometry(material: gray)))

        let canopy = SCNNode(geometry: SCNBox(width: 0.60, height: 0.36, length: 1.15, chamferRadius: 0.14))
        canopy.geometry?.firstMaterial = glass
        canopy.position = SCNVector3(0, 0.62, -0.45)
        root.addChildNode(canopy)

        addPropAndSpinner(to: root, spinnerZ: -3.85, spinnerMaterial: yellow, bladeLength: 1.3)
        return root
    }

    /// Fast mover: swept wings, bubble canopy, side intakes, afterburner glow.
    static func makeJet() -> SCNNode {
        let root = SCNNode()
        let gray = paint(0.55, 0.57, 0.60, roughness: 0.32, metal: 0.35)
        let darkGray = paint(0.22, 0.23, 0.26, roughness: 0.4, metal: 0.2)

        // Fuselage: needle nose → cockpit hump → tapered jetpipe.
        var radome = MeshData()
        let noseStations: [(Float, Float, Float, Float)] = [
            (-4.60, 0.05, 0.05, 0.00),
            (-3.80, 0.26, 0.26, 0.00),
            (-2.70, 0.46, 0.48, 0.02),
        ]
        radome.skin(rings: noseStations.map { fuselageRing(z: $0.0, rx: $0.1, ry: $0.2, yOff: $0.3) }, capStart: true, capEnd: false)
        root.addChildNode(SCNNode(geometry: radome.geometry(material: darkGray)))

        var body = MeshData()
        let bodyStations: [(Float, Float, Float, Float)] = [
            (-2.70, 0.46, 0.48, 0.02),
            (-1.20, 0.58, 0.62, 0.05),
            (0.50, 0.62, 0.60, 0.02),
            (2.00, 0.55, 0.52, 0.00),
            (3.50, 0.42, 0.40, 0.00),
            (4.30, 0.33, 0.31, 0.00),
        ]
        body.skin(rings: bodyStations.map { fuselageRing(z: $0.0, rx: $0.1, ry: $0.2, yOff: $0.3) }, capStart: false, capEnd: true)
        root.addChildNode(SCNNode(geometry: body.geometry(material: gray)))

        // Swept wings with wingtip missiles.
        for side in [Float(1), Float(-1)] {
            var wing = MeshData()
            let rootRing = airfoil(le: SIMD3(side * 0.55, -0.08, -0.55), chord: 2.60, thicknessDir: SIMD3(0, 1, 0), chordDir: SIMD3(0, 0, 1))
            let tipRing = airfoil(le: SIMD3(side * 3.75, 0.02, 1.60), chord: 0.95, thicknessDir: SIMD3(0, 1, 0), chordDir: SIMD3(0, 0, 1))
            wing.skin(rings: [rootRing, tipRing], capStart: true, capEnd: true)
            root.addChildNode(SCNNode(geometry: wing.geometry(material: gray)))

            let missile = SCNNode(geometry: SCNCapsule(capRadius: 0.09, height: 1.5))
            missile.geometry?.firstMaterial = paint(0.9, 0.9, 0.88, roughness: 0.4)
            missile.eulerAngles.x = -.pi / 2
            missile.position = SCNVector3(CGFloat(side) * 3.85, 0.02, 1.45)
            root.addChildNode(missile)

            // Swept tailplane.
            var tail = MeshData()
            let tr = airfoil(le: SIMD3(side * 0.30, 0.05, 3.15), chord: 1.30, thicknessDir: SIMD3(0, 1, 0), chordDir: SIMD3(0, 0, 1))
            let tt = airfoil(le: SIMD3(side * 1.90, 0.10, 4.05), chord: 0.60, thicknessDir: SIMD3(0, 1, 0), chordDir: SIMD3(0, 0, 1))
            tail.skin(rings: [tr, tt], capStart: true, capEnd: true)
            root.addChildNode(SCNNode(geometry: tail.geometry(material: gray)))

            // Side intake.
            let intake = SCNNode(geometry: SCNBox(width: 0.28, height: 0.52, length: 1.7, chamferRadius: 0.08))
            intake.geometry?.firstMaterial = darkGray
            intake.position = SCNVector3(CGFloat(side) * 0.72, -0.05, -0.35)
            root.addChildNode(intake)
        }

        // Tall swept fin with a red tip.
        var fin = MeshData()
        fin.skin(rings: [
            airfoil(le: SIMD3(0, 0.35, 2.90), chord: 1.55, thicknessDir: SIMD3(1, 0, 0), chordDir: SIMD3(0, 0, 1)),
            airfoil(le: SIMD3(0, 1.95, 3.95), chord: 0.70, thicknessDir: SIMD3(1, 0, 0), chordDir: SIMD3(0, 0, 1)),
        ], capStart: true, capEnd: true)
        root.addChildNode(SCNNode(geometry: fin.geometry(material: gray)))
        var finTip = MeshData()
        finTip.skin(rings: [
            airfoil(le: SIMD3(0, 1.95, 3.95), chord: 0.70, thicknessDir: SIMD3(1, 0, 0), chordDir: SIMD3(0, 0, 1)),
            airfoil(le: SIMD3(0, 2.30, 4.20), chord: 0.45, thicknessDir: SIMD3(1, 0, 0), chordDir: SIMD3(0, 0, 1)),
        ], capStart: false, capEnd: true)
        root.addChildNode(SCNNode(geometry: finTip.geometry(material: red)))

        // Bubble canopy.
        let canopy = SCNNode(geometry: SCNCapsule(capRadius: 0.42, height: 1.9))
        canopy.geometry?.firstMaterial = glass
        canopy.eulerAngles.x = -.pi / 2
        canopy.position = SCNVector3(0, 0.55, -1.45)
        canopy.scale = SCNVector3(0.85, 1, 1)
        root.addChildNode(canopy)

        // Jetpipe and afterburner glow.
        let nozzle = SCNNode(geometry: SCNTube(innerRadius: 0.20, outerRadius: 0.31, height: 0.30))
        nozzle.geometry?.firstMaterial = darkGray
        nozzle.eulerAngles.x = .pi / 2
        nozzle.position = SCNVector3(0, 0, 4.42)
        root.addChildNode(nozzle)
        let burner = SCNNode(geometry: SCNCylinder(radius: 0.19, height: 0.1))
        let glow = SCNMaterial()
        glow.lightingModel = .constant
        glow.emission.contents = NSColor(red: 1, green: 0.55, blue: 0.2, alpha: 1)
        glow.diffuse.contents = NSColor.black
        burner.geometry?.firstMaterial = glow
        burner.eulerAngles.x = .pi / 2
        burner.position = SCNVector3(0, 0, 4.45)
        root.addChildNode(burner)

        return root
    }

    private static func addPropAndSpinner(to root: SCNNode, spinnerZ: CGFloat, spinnerMaterial: SCNMaterial, bladeLength: CGFloat) {
        let spinner = SCNNode(geometry: SCNCone(topRadius: 0.02, bottomRadius: 0.22, height: 0.55))
        spinner.geometry?.firstMaterial = spinnerMaterial
        spinner.eulerAngles.x = -.pi / 2
        spinner.position = SCNVector3(0, 0, spinnerZ)
        root.addChildNode(spinner)

        let hub = SCNNode()
        hub.position = SCNVector3(0, 0, spinnerZ + 0.15)
        for k in 0..<2 {
            let blade = SCNNode(geometry: SCNBox(width: 0.16, height: bladeLength, length: 0.05, chamferRadius: 0.02))
            blade.geometry?.firstMaterial = dark
            blade.position = SCNVector3(0, (k == 0 ? 1 : -1) * bladeLength * 0.55, 0)
            blade.eulerAngles.y = k == 0 ? 0.35 : -0.35
            hub.addChildNode(blade)
        }
        hub.runAction(.repeatForever(.rotateBy(x: 0, y: 0, z: .pi * 2, duration: 0.07)))
        root.addChildNode(hub)
    }

    /// Stretch/orient a unit-height cylinder between two points.
    private static func placeCylinder(_ node: SCNNode, from: SIMD3<Float>, to: SIMD3<Float>) {
        let mid = (from + to) / 2
        let d = to - from
        let len = simd_length(d)
        node.simdPosition = mid
        node.simdScale = SIMD3(1, len, 1)
        // Rotate +Y onto the segment direction.
        let y = SIMD3<Float>(0, 1, 0)
        let dir = d / len
        let axis = simd_cross(y, dir)
        let axisLen = simd_length(axis)
        if axisLen > 1e-5 {
            node.simdOrientation = simd_quatf(angle: atan2(axisLen, simd_dot(y, dir)), axis: axis / axisLen)
        }
    }
}
