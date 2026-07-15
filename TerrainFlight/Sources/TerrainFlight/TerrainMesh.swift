import AppKit
import Foundation
import SceneKit
import simd

struct ChunkKey: Hashable {
    let cx: Int
    let cz: Int
}

enum TerrainMesh {
    /// Vertices per chunk edge (quads); 30 m spacing echoes the 30 m/px model.
    static let quads = 64
    static let spacing = 30.0
    static var chunkSize: Double { Double(quads) * spacing }

    /// Near-white tileable noise, shared by every chunk material.
    static let detailTexture: NSImage = {
        let size = 512
        let noise = PerlinNoise(seed: 424_242)
        var pixels = [UInt8](repeating: 0, count: size * size)
        for y in 0..<size {
            for x in 0..<size {
                let v = noise.fbm(Double(x) * 0.045, Double(y) * 0.045, octaves: 4)
                    + 0.4 * noise.fbm(Double(x) * 0.13, Double(y) * 0.13, octaves: 2)
                let g = 0.90 + 0.10 * v // subtle: ~0.76...1.0
                pixels[y * size + x] = UInt8(min(max(g, 0), 1) * 255)
            }
        }
        let cg = pixels.withUnsafeMutableBytes { buf -> CGImage? in
            guard let ctx = CGContext(
                data: buf.baseAddress, width: size, height: size,
                bitsPerComponent: 8, bytesPerRow: size,
                space: CGColorSpaceCreateDeviceGray(),
                bitmapInfo: CGImageAlphaInfo.none.rawValue
            ) else { return nil }
            return ctx.makeImage()
        }
        guard let image = cg else { return NSImage(size: NSSize(width: 1, height: 1)) }
        return NSImage(cgImage: image, size: NSSize(width: size, height: size))
    }()

    /// Builds a chunk node positioned at its world origin, with vertex positions
    /// local to the chunk (keeps Float precision healthy far from the origin).
    static func buildChunk(_ key: ChunkKey, terrain: TerrainGenerator) -> SCNNode {
        let n = quads
        let verts = n + 1
        let originX = Double(key.cx) * chunkSize
        let originZ = Double(key.cz) * chunkSize

        var positions = [SIMD3<Float>]()
        var normals = [SIMD3<Float>]()
        var colors = [SIMD3<Float>]()
        var uvs = [SIMD2<Float>]()
        positions.reserveCapacity(verts * verts)
        normals.reserveCapacity(verts * verts)
        colors.reserveCapacity(verts * verts)
        uvs.reserveCapacity(verts * verts)

        for iz in 0...n {
            for ix in 0...n {
                let wx = originX + Double(ix) * spacing
                let wz = originZ + Double(iz) * spacing
                let h = terrain.height(wx, wz)
                let nrm = terrain.normal(wx, wz)
                positions.append(SIMD3(Float(Double(ix) * spacing), Float(h), Float(Double(iz) * spacing)))
                normals.append(SIMD3(Float(nrm.x), Float(nrm.y), Float(nrm.z)))
                colors.append(terrain.color(x: wx, z: wz, h: h, normalY: nrm.y))
                // World-space UVs for the tiled detail texture (mirror wrap hides seams).
                uvs.append(SIMD2(Float(wx / 83.0), Float(wz / 83.0)))
            }
        }

        var indices = [UInt32]()
        indices.reserveCapacity(n * n * 6)
        for iz in 0..<n {
            for ix in 0..<n {
                let i0 = UInt32(iz * verts + ix)
                let i1 = i0 + 1
                let i2 = i0 + UInt32(verts)
                let i3 = i2 + 1
                indices.append(contentsOf: [i0, i2, i1, i1, i2, i3])
            }
        }

        let posSource = SCNGeometrySource(
            data: positions.withUnsafeBytes { Data($0) },
            semantic: .vertex,
            vectorCount: positions.count,
            usesFloatComponents: true,
            componentsPerVector: 3,
            bytesPerComponent: MemoryLayout<Float>.size,
            dataOffset: 0,
            dataStride: MemoryLayout<SIMD3<Float>>.stride
        )
        let nrmSource = SCNGeometrySource(
            data: normals.withUnsafeBytes { Data($0) },
            semantic: .normal,
            vectorCount: normals.count,
            usesFloatComponents: true,
            componentsPerVector: 3,
            bytesPerComponent: MemoryLayout<Float>.size,
            dataOffset: 0,
            dataStride: MemoryLayout<SIMD3<Float>>.stride
        )
        let colSource = SCNGeometrySource(
            data: colors.withUnsafeBytes { Data($0) },
            semantic: .color,
            vectorCount: colors.count,
            usesFloatComponents: true,
            componentsPerVector: 3,
            bytesPerComponent: MemoryLayout<Float>.size,
            dataOffset: 0,
            dataStride: MemoryLayout<SIMD3<Float>>.stride
        )
        let uvSource = SCNGeometrySource(
            data: uvs.withUnsafeBytes { Data($0) },
            semantic: .texcoord,
            vectorCount: uvs.count,
            usesFloatComponents: true,
            componentsPerVector: 2,
            bytesPerComponent: MemoryLayout<Float>.size,
            dataOffset: 0,
            dataStride: MemoryLayout<SIMD2<Float>>.stride
        )
        let element = SCNGeometryElement(indices: indices, primitiveType: .triangles)
        let geometry = SCNGeometry(sources: [posSource, nrmSource, colSource, uvSource], elements: [element])

        let material = SCNMaterial()
        material.diffuse.contents = NSColor.white
        material.lightingModel = .lambert
        material.isDoubleSided = true
        // High-frequency ground detail, modulated over the biome vertex colors.
        material.multiply.contents = detailTexture
        material.multiply.wrapS = .mirror
        material.multiply.wrapT = .mirror
        material.multiply.mipFilter = .linear
        geometry.firstMaterial = material

        let node = SCNNode(geometry: geometry)
        node.position = SCNVector3(originX, 0, originZ)
        node.castsShadow = false

        if let waterPatch = buildWaterPatch(key, terrain: terrain) {
            node.addChildNode(waterPatch)
        }
        if let lakePatch = buildLakePatch(key, terrain: terrain) {
            node.addChildNode(lakePatch)
        }
        if let forest = Scenery.buildForest(key, terrain: terrain) {
            node.addChildNode(forest)
        }
        if let town = Scenery.buildTown(key, terrain: terrain) {
            node.addChildNode(town)
        }
        return node
    }

    /// Deep-ocean color — the infinite floor beyond streamed chunks uses exactly
    /// this, so the edge of the chunk disk is invisible.
    static let deepWater = SIMD3<Float>(0.045, 0.14, 0.26)
    static let shallowWater = SIMD3<Float>(0.16, 0.40, 0.48)

    /// Gentle world-space waves: displaces water vertices and tilts their
    /// normals so the sun glints actually move.
    static let waveShader = """
    float t = scn_frame.time;
    float4 wp4 = scn_node.modelTransform * float4(_geometry.position.xyz, 1.0);
    float3 wp = wp4.xyz;
    float ph1 = wp.x * 0.021 + wp.z * 0.017 + t * 0.55;
    float ph2 = wp.x * -0.013 + wp.z * 0.024 + t * 0.38;
    _geometry.position.y += sin(ph1) * 0.5 + sin(ph2) * 0.35;
    float ddx = 0.021 * cos(ph1) * 0.5 - 0.013 * cos(ph2) * 0.35;
    float ddz = 0.017 * cos(ph1) * 0.5 + 0.024 * cos(ph2) * 0.35;
    _geometry.normal = normalize(_geometry.normal + float3(-ddx * 8.0, 0.0, -ddz * 8.0));
    """

    static func waterMaterial() -> SCNMaterial {
        let m = SCNMaterial()
        m.diffuse.contents = NSColor.white
        m.lightingModel = .blinn
        m.specular.contents = NSColor(white: 0.85, alpha: 1)
        m.shininess = 80
        m.shaderModifiers = [.geometry: waveShader]
        return m
    }

    /// Opaque water surface with satellite-style depth coloring: turquoise
    /// shallows fading to navy. Replaces alpha-transparency (which made the
    /// water change color wherever a seabed chunk happened to be loaded).
    private static func buildWaterPatch(_ key: ChunkKey, terrain: TerrainGenerator) -> SCNNode? {
        let n = 16
        let step = chunkSize / Double(n)
        let verts = n + 1
        let originX = Double(key.cx) * chunkSize
        let originZ = Double(key.cz) * chunkSize

        var positions = [SIMD3<Float>]()
        var normals = [SIMD3<Float>]()
        var colors = [SIMD3<Float>]()
        var anyWater = false

        for iz in 0...n {
            for ix in 0...n {
                let wx = originX + Double(ix) * step
                let wz = originZ + Double(iz) * step
                let depth = -terrain.height(wx, wz)
                if depth > 0 { anyWater = true }
                let t = Float(min(max((depth - 2) / 55.0, 0), 1))
                let tt = t * t * (3 - 2 * t)
                positions.append(SIMD3(Float(Double(ix) * step), 0.6, Float(Double(iz) * step)))
                normals.append(SIMD3(0, 1, 0))
                colors.append(shallowWater + (deepWater - shallowWater) * tt)
            }
        }
        guard anyWater else { return nil }

        var indices = [UInt32]()
        for iz in 0..<n {
            for ix in 0..<n {
                let i0 = UInt32(iz * verts + ix)
                let i1 = i0 + 1
                let i2 = i0 + UInt32(verts)
                let i3 = i2 + 1
                indices.append(contentsOf: [i0, i2, i1, i1, i2, i3])
            }
        }

        func source(_ data: [SIMD3<Float>], _ semantic: SCNGeometrySource.Semantic) -> SCNGeometrySource {
            SCNGeometrySource(
                data: data.withUnsafeBytes { Data($0) },
                semantic: semantic, vectorCount: data.count,
                usesFloatComponents: true, componentsPerVector: 3,
                bytesPerComponent: 4, dataOffset: 0, dataStride: MemoryLayout<SIMD3<Float>>.stride
            )
        }
        let geometry = SCNGeometry(
            sources: [source(positions, .vertex), source(normals, .normal), source(colors, .color)],
            elements: [SCNGeometryElement(indices: indices, primitiveType: .triangles)]
        )
        geometry.firstMaterial = waterMaterial()
        let node = SCNNode(geometry: geometry)
        node.castsShadow = false
        return node
    }

    /// Freshwater surface over carved lakes and rivers. Vertices outside the
    /// water mask drop below the carved bed, hiding the skirt under the banks.
    private static func buildLakePatch(_ key: ChunkKey, terrain: TerrainGenerator) -> SCNNode? {
        let n = 24
        let step = chunkSize / Double(n)
        let verts = n + 1
        let originX = Double(key.cx) * chunkSize
        let originZ = Double(key.cz) * chunkSize

        var positions = [SIMD3<Float>]()
        var normals = [SIMD3<Float>]()
        var colors = [SIMD3<Float>]()
        var anyWater = false

        let shallow = SIMD3<Float>(0.16, 0.36, 0.36)
        let deep = SIMD3<Float>(0.05, 0.14, 0.19)

        for iz in 0...n {
            for ix in 0...n {
                let wx = originX + Double(ix) * step
                let wz = originZ + Double(iz) * step
                let info = terrain.sample(wx, wz)
                let wet = info.mask > 0.3 && info.surface > info.height + 0.5
                let y: Double
                if wet {
                    anyWater = true
                    y = info.surface
                } else {
                    // Bury the skirt beneath the carved bed.
                    y = min(info.height, info.surface) - 18
                }
                let depth = info.surface - info.height
                let t = Float(min(max((depth - 1) / 10.0, 0), 1))
                positions.append(SIMD3(Float(Double(ix) * step), Float(y), Float(Double(iz) * step)))
                normals.append(SIMD3(0, 1, 0))
                colors.append(shallow + (deep - shallow) * (t * t * (3 - 2 * t)))
            }
        }
        guard anyWater else { return nil }

        var indices = [UInt32]()
        for iz in 0..<n {
            for ix in 0..<n {
                let i0 = UInt32(iz * verts + ix)
                let i1 = i0 + 1
                let i2 = i0 + UInt32(verts)
                let i3 = i2 + 1
                indices.append(contentsOf: [i0, i2, i1, i1, i2, i3])
            }
        }

        func source(_ data: [SIMD3<Float>], _ semantic: SCNGeometrySource.Semantic) -> SCNGeometrySource {
            SCNGeometrySource(
                data: data.withUnsafeBytes { Data($0) },
                semantic: semantic, vectorCount: data.count,
                usesFloatComponents: true, componentsPerVector: 3,
                bytesPerComponent: 4, dataOffset: 0, dataStride: MemoryLayout<SIMD3<Float>>.stride
            )
        }
        let geometry = SCNGeometry(
            sources: [source(positions, .vertex), source(normals, .normal), source(colors, .color)],
            elements: [SCNGeometryElement(indices: indices, primitiveType: .triangles)]
        )
        geometry.firstMaterial = waterMaterial()
        let node = SCNNode(geometry: geometry)
        node.castsShadow = false
        return node
    }
}
