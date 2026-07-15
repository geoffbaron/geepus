import Foundation
import SceneKit
import simd

struct FlightInput {
    var pitch = 0.0   // +1 pulls the nose up
    var roll = 0.0    // +1 rolls right
    var yaw = 0.0     // +1 yaws right
    var throttleUp = false
    var throttleDown = false
}

/// Handling + performance envelope; swapped when the game mode changes.
struct FlightTuning {
    var minSpeed: Double
    var cruiseMax: Double   // level top speed at full throttle
    var maxSpeed: Double    // absolute limit (diving)
    var stallSpeed: Double
    var pitchRate: Double
    var rollRate: Double
    var yawRate: Double

    /// The familiar baseline handling; other vehicles change speed envelope
    /// more than they change feel.
    static let cessna = FlightTuning(
        minSpeed: 25, cruiseMax: 150, maxSpeed: 210, stallSpeed: 42,
        pitchRate: 0.95, rollRate: 1.75, yawRate: 0.45
    )
    static let spitfire = FlightTuning(
        minSpeed: 45, cruiseMax: 160, maxSpeed: 205, stallSpeed: 55,
        pitchRate: 0.95, rollRate: 1.75, yawRate: 0.45
    )
    /// Fast mover: double the speeds, slightly crisper roll.
    static let jet = FlightTuning(
        minSpeed: 70, cruiseMax: 320, maxSpeed: 430, stallSpeed: 85,
        pitchRate: 1.1, rollRate: 2.4, yawRate: 0.4
    )
    /// Bandit performance ramps up with the player's kill count: early bandits
    /// are slow, floaty targets; veterans get faster and turn much harder.
    static func bandit(kills: Int) -> FlightTuning {
        let k = Double(kills)
        return FlightTuning(
            minSpeed: 32,
            cruiseMax: min(58 + k * 2.5, 100),
            maxSpeed: min(85 + k * 3, 130),
            stallSpeed: 36,
            pitchRate: min(0.42 + k * 0.03, 0.85),
            rollRate: min(0.85 + k * 0.06, 1.6),
            yawRate: 0.35
        )
    }
}

/// The player's selectable aircraft.
enum Vehicle: CaseIterable {
    case cessna
    case spitfire
    case jet

    var displayName: String {
        switch self {
        case .cessna: return "CESSNA"
        case .spitfire: return "SPITFIRE"
        case .jet: return "JET"
        }
    }

    var tuning: FlightTuning {
        switch self {
        case .cessna: return .cessna
        case .spitfire: return .spitfire
        case .jet: return .jet
        }
    }

    func makeNode() -> SCNNode {
        switch self {
        case .cessna: return AircraftModel.makeNode()
        case .spitfire: return AircraftModel.makeSpitfire()
        case .jet: return AircraftModel.makeJet()
        }
    }

    var next: Vehicle {
        let all = Vehicle.allCases
        return all[(all.firstIndex(of: self)! + 1) % all.count]
    }
}

/// Arcade flight model: bank-to-turn, dive-to-accelerate, gentle stall sink.
/// Control inputs are low-pass filtered so key taps feel like stick pressure,
/// not switches.
final class Aircraft {
    var position = SIMD3<Double>(0, 500, 0)
    var orientation = simd_quatd(angle: 0, axis: SIMD3(0, 1, 0))
    var speed = 75.0        // m/s
    var throttle = 0.6      // 0...1
    var tuning = FlightTuning.cessna

    var minSpeed: Double { tuning.minSpeed }
    var maxSpeed: Double { tuning.maxSpeed }
    var stallSpeed: Double { tuning.stallSpeed }

    // Smoothed control state (what the "stick" is actually doing).
    private var ctlPitch = 0.0
    private var ctlRoll = 0.0
    private var ctlYaw = 0.0

    var forward: SIMD3<Double> { orientation.act(SIMD3(0, 0, -1)) }
    var up: SIMD3<Double> { orientation.act(SIMD3(0, 1, 0)) }
    var right: SIMD3<Double> { orientation.act(SIMD3(1, 0, 0)) }

    func update(
        dt: Double,
        input: FlightInput,
        wind: SIMD3<Double> = .zero,
        wobblePitch: Double = 0,
        wobbleRoll: Double = 0
    ) {
        if input.throttleUp { throttle = min(1, throttle + 0.45 * dt) }
        if input.throttleDown { throttle = max(0, throttle - 0.45 * dt) }

        // Ease the stick toward the commanded input; release re-centers a bit faster.
        let attack = 1 - exp(-dt * 3.8)
        let release = 1 - exp(-dt * 5.5)
        ctlPitch += (input.pitch - ctlPitch) * (input.pitch == 0 ? release : attack)
        ctlRoll += (input.roll - ctlRoll) * (input.roll == 0 ? release : attack)
        ctlYaw += (input.yaw - ctlYaw) * (input.yaw == 0 ? release : attack)

        // Control authority grows with airspeed.
        let authority = min(1.0, speed / 90.0) * 0.6 + 0.4

        // Body-frame rotation rates (rad/s). +X rotation pitches the nose up.
        let pitchRate = ctlPitch * tuning.pitchRate * authority + wobblePitch
        let rollRate = -ctlRoll * tuning.rollRate * authority + wobbleRoll
        let yawRate = -ctlYaw * tuning.yawRate * authority

        let dq = simd_quatd(angle: pitchRate * dt, axis: SIMD3(1, 0, 0))
            * simd_quatd(angle: yawRate * dt, axis: SIMD3(0, 1, 0))
            * simd_quatd(angle: rollRate * dt, axis: SIMD3(0, 0, 1))
        orientation = simd_normalize(orientation * dq)

        // Bank-to-turn: banking left (right wingtip up) turns left.
        let bank = right.y
        let turnRate = bank * 0.55 * min(1.2, speed / 80.0)
        orientation = simd_normalize(simd_quatd(angle: turnRate * dt, axis: SIMD3(0, 1, 0)) * orientation)

        // Mild self-leveling when hands are off the stick.
        if input.roll == 0 && abs(bank) > 0.02 {
            orientation = simd_normalize(simd_quatd(angle: -bank * 0.5 * dt, axis: forward) * orientation)
        }

        // Airspeed chases the throttle setting; diving trades altitude for speed.
        let targetSpeed = tuning.minSpeed + throttle * (tuning.cruiseMax - tuning.minSpeed)
        speed += (targetSpeed - speed) * min(1, dt * 0.45)
        speed += -forward.y * 9.8 * dt * 1.1
        speed = min(max(speed, minSpeed * 0.8), maxSpeed)

        position += (forward * speed + wind) * dt

        // Below stall speed the plane mushes downward.
        if speed < stallSpeed {
            position.y -= (stallSpeed - speed) * 1.6 * dt
        }
    }

    func reset(over terrain: TerrainGenerator) {
        // Random respawn: sample candidate spots in a wide ring around the
        // current position and take the one with the least terrain below and
        // ahead of a randomly chosen heading — a fresh coastline every time.
        let heading = Double.random(in: 0..<(2 * .pi))
        var best = SIMD3<Double>(position.x, 0, position.z)
        var bestScore = Double.infinity
        for _ in 0..<64 {
            let a = Double.random(in: 0..<(2 * .pi))
            let d = Double.random(in: 6000...30000)
            let x = position.x + cos(a) * d
            let z = position.z + sin(a) * d
            // Safety: little terrain directly ahead of the spawn heading.
            var aheadScore = 0.0
            for s in stride(from: 0.0, through: 6000, by: 1500) {
                aheadScore += max(terrain.height(x - sin(heading) * s, z - cos(heading) * s), 0)
            }
            guard aheadScore < 60 else { continue }
            // Scenery: require actual coastline nearby, not open ocean.
            var landCount = 0
            for k in 0..<16 {
                let la = Double(k) / 16 * 2 * .pi
                let lr = 1500.0 + Double(k % 4) * 800
                if terrain.height(x + cos(la) * lr, z + sin(la) * lr) > 15 { landCount += 1 }
            }
            guard landCount >= 2 else { continue }
            // Prefer more land in view, then a clearer path ahead.
            let score = aheadScore - Double(landCount) * 25
            if score < bestScore {
                bestScore = score
                best = SIMD3(x, 0, z)
            }
        }
        let ground = terrain.height(best.x, best.z)
        position = SIMD3(best.x, max(ground, 0) + 400, best.z)
        orientation = simd_quatd(angle: heading, axis: SIMD3(0, 1, 0))
        speed = 75
        throttle = 0.6
        ctlPitch = 0
        ctlRoll = 0
        ctlYaw = 0
    }

    var headingDegrees: Int {
        let f = forward
        var deg = atan2(-f.x, -f.z) * 180 / .pi
        if deg < 0 { deg += 360 }
        return Int(deg.rounded()) % 360
    }
}
