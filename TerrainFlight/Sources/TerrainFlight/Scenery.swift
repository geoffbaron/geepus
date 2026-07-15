import AppKit
import Foundation
import SceneKit
import simd

/// Per-chunk scenery — forests and towns — merged into one geometry each so a
/// whole chunk of trees or buildings costs a single draw call.
enum Scenery {

    private struct Builder {
        var positions: [SIMD3<Float>] = []
        var normals: [SIMD3<Float>] = []
        var colors: [SIMD3<Float>] = []
        var indices: [UInt32] = []

        mutating func addTri(_ a: SIMD3<Float>, _ b: SIMD3<Float>, _ c: SIMD3<Float>, color: SIMD3<Float>) {
            let n = simd_normalize(simd_cross(b - a, c - a))
            let start = UInt32(positions.count)
            positions.append(contentsOf: [a, b, c])
            normals.append(contentsOf: [n, n, n])
            colors.append(contentsOf: [color, color, color])
            indices.append(contentsOf: [start, start + 1, start + 2])
        }

        /// Axis-aligned box with separate wall and roof colors (no bottom face).
        mutating func addBuilding(center: SIMD3<Float>, w: Float, d: Float, h: Float, wall: SIMD3<Float>, roof: SIMD3<Float>) {
            let x0 = center.x - w / 2, x1 = center.x + w / 2
            let z0 = center.z - d / 2, z1 = center.z + d / 2
            let y0 = center.y, y1 = center.y + h
            let a = SIMD3(x0, y0, z0), b = SIMD3(x1, y0, z0), c = SIMD3(x1, y0, z1), d4 = SIMD3(x0, y0, z1)
            let e = SIMD3(x0, y1, z0), f = SIMD3(x1, y1, z0), g = SIMD3(x1, y1, z1), i = SIMD3(x0, y1, z1)
            addQuad(a, b, f, e, color: wall)   // -z
            addQuad(c, d4, i, g, color: wall)  // +z
            addQuad(b, c, g, f, color: wall)   // +x
            addQuad(d4, a, e, i, color: wall)  // -x
            addQuad(e, f, g, i, color: roof)   // top
        }

        mutating func addQuad(_ a: SIMD3<Float>, _ b: SIMD3<Float>, _ c: SIMD3<Float>, _ d: SIMD3<Float>, color: SIMD3<Float>) {
            addTri(a, b, c, color: color)
            addTri(a, c, d, color: color)
        }

        /// Low-poly conifer: 6-sided cone canopy over a stub trunk.
        mutating func addTree(at p: SIMD3<Float>, height: Float, radius: Float, canopy: SIMD3<Float>, trunk: SIMD3<Float>) {
            let trunkTop = p + SIMD3(0, height * 0.2, 0)
            addQuad(
                p + SIMD3(-0.4, 0, -0.4), p + SIMD3(0.4, 0, -0.4),
                trunkTop + SIMD3(0.4, 0, 0.4), trunkTop + SIMD3(-0.4, 0, 0.4),
                color: trunk
            )
            let apex = p + SIMD3(0, height, 0)
            let baseY = p.y + height * 0.12
            var ring: [SIMD3<Float>] = []
            for k in 0..<6 {
                let a = Float(k) / 6 * 2 * .pi
                ring.append(SIMD3(p.x + cos(a) * radius, baseY, p.z + sin(a) * radius))
            }
            for k in 0..<6 {
                addTri(ring[k], apex, ring[(k + 1) % 6], color: canopy)
            }
        }

        func node() -> SCNNode? {
            guard !indices.isEmpty else { return nil }
            func src(_ d: [SIMD3<Float>], _ s: SCNGeometrySource.Semantic) -> SCNGeometrySource {
                SCNGeometrySource(
                    data: d.withUnsafeBytes { Data($0) }, semantic: s, vectorCount: d.count,
                    usesFloatComponents: true, componentsPerVector: 3,
                    bytesPerComponent: 4, dataOffset: 0, dataStride: MemoryLayout<SIMD3<Float>>.stride
                )
            }
            let geo = SCNGeometry(
                sources: [src(positions, .vertex), src(normals, .normal), src(colors, .color)],
                elements: [SCNGeometryElement(indices: indices, primitiveType: .triangles)]
            )
            let mat = SCNMaterial()
            mat.diffuse.contents = NSColor.white
            mat.lightingModel = .lambert
            geo.firstMaterial = mat
            let node = SCNNode(geometry: geo)
            node.castsShadow = false
            return node
        }
    }

    private static func rngUnit(_ rng: inout SplitMix64) -> Double {
        Double(rng.next() % 100_000) / 100_000
    }

    /// Conifer forest scattered where the biome coloring grows forest.
    static func buildForest(_ key: ChunkKey, terrain: TerrainGenerator) -> SCNNode? {
        var b = Builder()
        var rng = SplitMix64(state: terrain.seed ^ (UInt64(bitPattern: Int64(key.cx)) &* 0x1F3B) ^ (UInt64(bitPattern: Int64(key.cz)) &* 0x9E37_79B9))
        let originX = Double(key.cx) * TerrainMesh.chunkSize
        let originZ = Double(key.cz) * TerrainMesh.chunkSize
        let cells = 12
        let cellSize = TerrainMesh.chunkSize / Double(cells)
        var count = 0

        for cz in 0..<cells {
            for cx in 0..<cells {
                if count >= 150 { break }
                let u = rngUnit(&rng), v = rngUnit(&rng), roll = rngUnit(&rng)
                let wx = originX + (Double(cx) + u) * cellSize
                let wz = originZ + (Double(cz) + v) * cellSize
                let density = terrain.forestDensity(wx, wz)
                guard density > 0.35, roll < density else { continue }

                let info = terrain.sample(wx, wz)
                let snowLine = terrain.snowline(wx, wz)
                let treeline = min(snowLine + 50, 1150)
                guard info.height > 10, info.height < treeline, info.mask < 0.2 else { continue }
                let nrm = terrain.normal(wx, wz)
                guard nrm.y > 0.75 else { continue }

                let th = Float(7 + rngUnit(&rng) * 8)
                let tr = Float(2.2 + rngUnit(&rng) * 2.2)
                var canopy = SIMD3<Float>(0.07, Float(0.20 + rngUnit(&rng) * 0.13), 0.06)
                // Snow-dusted near/above the snowline.
                let snowAmt = Float(smootherStep((info.height - (snowLine - 180)) / 180))
                canopy = canopy + (SIMD3<Float>(0.88, 0.90, 0.94) - canopy) * snowAmt
                b.addTree(
                    at: SIMD3(Float(wx - originX), Float(info.height - 0.5), Float(wz - originZ)),
                    height: th, radius: tr,
                    canopy: canopy, trunk: SIMD3(0.22, 0.15, 0.09)
                )
                count += 1
            }
        }
        return b.node()
    }

    /// Small settlements on flat, low, dry ground where the town field is high.
    static func buildTown(_ key: ChunkKey, terrain: TerrainGenerator) -> SCNNode? {
        var b = Builder()
        var rng = SplitMix64(state: terrain.seed ^ (UInt64(bitPattern: Int64(key.cx)) &* 0x8DA6) ^ (UInt64(bitPattern: Int64(key.cz)) &* 0x2545_F491))
        let originX = Double(key.cx) * TerrainMesh.chunkSize
        let originZ = Double(key.cz) * TerrainMesh.chunkSize
        let cells = 10
        let cellSize = TerrainMesh.chunkSize / Double(cells)
        var count = 0

        let walls: [SIMD3<Float>] = [
            SIMD3(0.85, 0.82, 0.74), SIMD3(0.78, 0.70, 0.58), SIMD3(0.72, 0.55, 0.45), SIMD3(0.66, 0.68, 0.70),
        ]
        let roofs: [SIMD3<Float>] = [
            SIMD3(0.28, 0.28, 0.30), SIMD3(0.45, 0.20, 0.15), SIMD3(0.35, 0.33, 0.28),
        ]

        for cz in 0..<cells {
            for cx in 0..<cells {
                if count >= 80 { break }
                let u = rngUnit(&rng), v = rngUnit(&rng), roll = rngUnit(&rng)
                let wx = originX + (Double(cx) + u * 0.6 + 0.2) * cellSize
                let wz = originZ + (Double(cz) + v * 0.6 + 0.2) * cellSize
                let density = terrain.townDensity(wx, wz)
                guard density > 0.4, roll < density * 0.8 else { continue }

                let info = terrain.sample(wx, wz)
                guard info.height > 4, info.height < 70, info.mask < 0.1 else { continue }
                let nrm = terrain.normal(wx, wz)
                guard nrm.y > 0.985 else { continue }

                let w = Float(8 + rngUnit(&rng) * 10)
                let d = Float(8 + rngUnit(&rng) * 10)
                var h = Float(6 + rngUnit(&rng) * 12)
                if rngUnit(&rng) < 0.06 { h = 26 + Float(rngUnit(&rng)) * 18 }
                b.addBuilding(
                    center: SIMD3(Float(wx - originX), Float(info.height - 1.5), Float(wz - originZ)),
                    w: w, d: d, h: h,
                    wall: walls[Int(rng.next() % UInt64(walls.count))],
                    roof: roofs[Int(rng.next() % UInt64(roofs.count))]
                )
                count += 1
            }
        }
        return b.node()
    }

    private static func smootherStep(_ x: Double) -> Double {
        let t = min(max(x, 0), 1)
        return t * t * (3 - 2 * t)
    }
}
