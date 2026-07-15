import Foundation
import simd

// Deterministic RNG for shuffling the permutation table from a seed.
struct SplitMix64 {
    var state: UInt64
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

final class PerlinNoise {
    private var perm = [Int](repeating: 0, count: 512)

    init(seed: UInt64) {
        var p = Array(0..<256)
        var rng = SplitMix64(state: seed)
        for i in stride(from: 255, to: 0, by: -1) {
            let j = Int(rng.next() % UInt64(i + 1))
            p.swapAt(i, j)
        }
        for i in 0..<512 { perm[i] = p[i & 255] }
    }

    private func fade(_ t: Double) -> Double { t * t * t * (t * (t * 6 - 15) + 10) }
    private func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }

    private func grad(_ h: Int, _ x: Double, _ y: Double) -> Double {
        switch h & 7 {
        case 0: return  x + y
        case 1: return -x + y
        case 2: return  x - y
        case 3: return -x - y
        case 4: return  x
        case 5: return -x
        case 6: return  y
        default: return -y
        }
    }

    /// 2D gradient noise, roughly in -1...1.
    func noise(_ x: Double, _ y: Double) -> Double {
        let xf0 = floor(x), yf0 = floor(y)
        let xi = Int(xf0) & 255, yi = Int(yf0) & 255
        let xf = x - xf0, yf = y - yf0
        let u = fade(xf), v = fade(yf)
        let aa = perm[perm[xi] + yi]
        let ab = perm[perm[xi] + yi + 1]
        let ba = perm[perm[xi + 1] + yi]
        let bb = perm[perm[xi + 1] + yi + 1]
        let x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u)
        let x2 = lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u)
        return lerp(x1, x2, v)
    }

    func fbm(_ x: Double, _ y: Double, octaves: Int, lacunarity: Double = 2.0, gain: Double = 0.5) -> Double {
        var sum = 0.0, amp = 1.0, freq = 1.0, norm = 0.0
        for _ in 0..<octaves {
            sum += amp * noise(x * freq, y * freq)
            norm += amp
            amp *= gain
            freq *= lacunarity
        }
        return sum / norm
    }

    /// Ridged multifractal in 0...1 — sharp crests, like eroded mountain ranges.
    func ridged(_ x: Double, _ y: Double, octaves: Int, lacunarity: Double = 2.0, gain: Double = 0.5) -> Double {
        var sum = 0.0, amp = 1.0, freq = 1.0, norm = 0.0
        for _ in 0..<octaves {
            let n = 1.0 - abs(noise(x * freq, y * freq))
            sum += amp * n * n
            norm += amp
            amp *= gain
            freq *= lacunarity
        }
        return sum / norm
    }
}

private func smoothstep(_ a: Double, _ b: Double, _ x: Double) -> Double {
    let t = min(max((x - a) / (b - a), 0), 1)
    return t * t * (3 - 2 * t)
}

/// Infinite, deterministic, randomly-accessible elevation field (meters), in the
/// spirit of terrain-diffusion's output: continents, coastal shelves, ridged ranges.
final class TerrainGenerator {
    let seed: UInt64
    private let base: PerlinNoise
    private let warp: PerlinNoise
    private let ridge: PerlinNoise
    private let detail: PerlinNoise
    private let climate: PerlinNoise
    private let lakes: PerlinNoise
    private let rivers: PerlinNoise
    private let towns: PerlinNoise

    /// 0 (temperate) ... 0.7 (deep winter): pulls snow and tree lines down.
    let winterFactor: Double

    init(seed: UInt64) {
        self.seed = seed
        base = PerlinNoise(seed: seed &+ 1)
        warp = PerlinNoise(seed: seed &+ 2)
        ridge = PerlinNoise(seed: seed &+ 3)
        detail = PerlinNoise(seed: seed &+ 4)
        climate = PerlinNoise(seed: seed &+ 5)
        lakes = PerlinNoise(seed: seed &+ 6)
        rivers = PerlinNoise(seed: seed &+ 7)
        towns = PerlinNoise(seed: seed &+ 8)
        winterFactor = Double((seed &* 2_654_435_761) % 1000) / 1000 * 0.7
    }

    struct WaterInfo {
        var height: Double
        var mask: Double     // 0...1 inland-water coverage
        var surface: Double  // lake/river surface elevation
    }

    /// Elevation plus inland-water field — lakes and winding rivers are carved
    /// into the terrain below a slowly varying water table.
    func sample(_ x: Double, _ z: Double) -> WaterInfo {
        // Domain warp so coastlines and ranges meander instead of looking griddy.
        let wx = x + 900 * warp.fbm(x * 0.00022, z * 0.00022, octaves: 3)
        let wz = z + 900 * warp.fbm(x * 0.00022 + 137.7, z * 0.00022 + 89.2, octaves: 3)

        // Continents on a ~25 km scale.
        let continent = base.fbm(wx * 0.00004, wz * 0.00004, octaves: 4)
        // Where mountain ranges are allowed to grow.
        let rangeMask = smoothstep(0.02, 0.5, continent + 0.25 * base.fbm(wx * 0.00012, wz * 0.00012, octaves: 3))

        let ridged = ridge.ridged(wx * 0.00016, wz * 0.00016, octaves: 5)
        let mountains = pow(ridged, 2.2) * 2300 * rangeMask
        let hills = detail.fbm(wx * 0.001, wz * 0.001, octaves: 5) * (60 + 120 * rangeMask)

        var h = continent * 420 + hills + mountains

        // Gentle coastal shelf so beaches read as beaches.
        if h > -60 && h < 40 {
            h *= 0.55 + 0.45 * abs(h) / 60.0
        }

        // Inland water: lake blobs plus thin winding river bands, carved down
        // to a low-frequency water table in low-relief inland terrain.
        let table = 16 + 240 * max(0, continent)
        let lakeN = lakes.fbm(wx * 0.00028, wz * 0.00028, octaves: 3)
        let riverN = rivers.fbm(wx * 0.00011, wz * 0.00011, octaves: 3)
        let riverBand = 1 - min(abs(riverN) * 30, 1.0)
        var mask = max(
            smoothstep(0.50, 0.62, lakeN),
            smoothstep(0.55, 0.85, riverBand) * 0.95
        )
        mask *= smoothstep(6, 26, h)            // stay out of the ocean/beach
        mask *= smoothstep(200, 40, h - table)  // no gorges through mountains
        if mask > 0.01 {
            let carved = min(h, table - 15)
            h += (carved - h) * smoothstep(0.12, 0.55, mask)
        }
        return WaterInfo(height: h, mask: mask, surface: table - 1)
    }

    /// Elevation in meters at world position (x, z) in meters. Sea level is 0.
    func height(_ x: Double, _ z: Double) -> Double {
        sample(x, z).height
    }

    /// Forest coverage 0...1 — matches the forest tint in `color`.
    func forestDensity(_ x: Double, _ z: Double) -> Double {
        let moisture = 0.5 + 0.5 * climate.fbm(x * 0.00008 + 51.3, z * 0.00008 + 7.9, octaves: 3)
        let veg = 0.5 + 0.5 * climate.fbm(x * 0.0009 + 271.4, z * 0.0009 + 88.1, octaves: 4)
        return smoothstep(0.45, 0.75, moisture * 0.55 + veg * 0.45)
    }

    /// Settlement density 0...1 on a ~15 km scale.
    func townDensity(_ x: Double, _ z: Double) -> Double {
        smoothstep(0.35, 0.55, towns.fbm(x * 0.00006 + 12.5, z * 0.00006 + 77.1, octaves: 2))
    }

    /// Local snowline elevation (meters).
    func snowline(_ x: Double, _ z: Double) -> Double {
        1350 - winterFactor * 700 + 350 * climate.fbm(x * 0.00015 + 913, z * 0.00015 + 311, octaves: 2)
    }

    /// Surface normal from central differences (continuous across chunk seams).
    func normal(_ x: Double, _ z: Double, eps: Double = 15.0) -> SIMD3<Double> {
        let hl = height(x - eps, z), hr = height(x + eps, z)
        let hd = height(x, z - eps), hu = height(x, z + eps)
        return simd_normalize(SIMD3(hl - hr, 2 * eps, hd - hu))
    }

    /// Ground albedo by elevation, slope, moisture, and vegetation cover —
    /// tuned toward satellite-photo earth tones rather than "video game green".
    func color(x: Double, z: Double, h: Double, normalY: Double) -> SIMD3<Float> {
        let moisture = 0.5 + 0.5 * climate.fbm(x * 0.00008 + 51.3, z * 0.00008 + 7.9, octaves: 3)
        let jitter = 0.5 + 0.5 * climate.fbm(x * 0.004, z * 0.004, octaves: 2)
        // Patchy vegetation cover at ~1 km scale.
        let veg = 0.5 + 0.5 * climate.fbm(x * 0.0009 + 271.4, z * 0.0009 + 88.1, octaves: 4)
        // Rock strata tint at ~2 km scale.
        let strata = 0.5 + 0.5 * climate.fbm(x * 0.0005 + 631.2, z * 0.0005 + 402.7, octaves: 3)

        let sand = SIMD3<Double>(0.76, 0.68, 0.50)
        let steppe = SIMD3<Double>(0.56, 0.47, 0.30)
        let grassOlive = SIMD3<Double>(0.38, 0.40, 0.20)
        let grassLush = SIMD3<Double>(0.20, 0.32, 0.12)
        let forest = SIMD3<Double>(0.08, 0.19, 0.08)
        let rockBrown = SIMD3<Double>(0.42, 0.35, 0.28)
        let rockGray = SIMD3<Double>(0.47, 0.45, 0.43)
        let snow = SIMD3<Double>(0.93, 0.94, 0.97)
        let seabed = SIMD3<Double>(0.32, 0.36, 0.30)

        let rock = simd_mix(rockBrown, rockGray, SIMD3(repeating: strata))

        var c: SIMD3<Double>
        if h < -4 {
            c = seabed
        } else if h < 6 {
            c = sand
        } else {
            // Dry steppe → olive grassland → lush grass by moisture.
            var ground = simd_mix(steppe, grassOlive, SIMD3(repeating: smoothstep(0.25, 0.55, moisture)))
            ground = simd_mix(ground, grassLush, SIMD3(repeating: smoothstep(0.55, 0.85, moisture)))
            // Forest patches where it's wet enough, between the coast and the treeline.
            let cover = smoothstep(0.45, 0.75, moisture * 0.55 + veg * 0.45)
                * smoothstep(15, 120, h) * smoothstep(1150, 700, h)
            ground = simd_mix(ground, forest, SIMD3(repeating: cover))
            // Alpine transition to bare rock.
            c = simd_mix(ground, rock, SIMD3(repeating: smoothstep(550, 1150, h)))
        }

        // Steep faces are bare rock at any elevation.
        let steep = smoothstep(0.88, 0.72, normalY)
        c = simd_mix(c, rock, SIMD3(repeating: steep * (h > 6 ? 1 : 0.3)))

        // Snow above a wandering snowline (winter seeds pull it far down),
        // but not on cliffs.
        let snowLine = snowline(x, z)
        let snowAmt = smoothstep(snowLine, snowLine + 220, h) * smoothstep(0.65, 0.85, normalY)
        c = simd_mix(c, snow, SIMD3(repeating: snowAmt))

        // Cheap cavity shading: valley floors and gullies sit a touch darker.
        let avgAround = (height(x + 90, z) + height(x - 90, z) + height(x, z + 90) + height(x, z - 90)) / 4
        let cavity = min(max((avgAround - h) / 55.0, 0), 0.30)
        c *= (1.0 - cavity)

        // Small-scale variation so plains aren't flat-shaded felt.
        c *= 0.92 + 0.16 * jitter
        return SIMD3<Float>(Float(c.x), Float(c.y), Float(c.z))
    }
}
