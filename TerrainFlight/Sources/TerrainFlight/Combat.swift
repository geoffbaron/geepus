import AppKit
import Foundation
import SceneKit
import simd

/// A tracer round in flight.
private struct Bullet {
    let node: SCNNode
    var position: SIMD3<Double>
    let velocity: SIMD3<Double>
    var ttl: Double
    let fromPlayer: Bool
}

/// One AI bandit: an Aircraft steered by a small dogfight state machine.
final class Enemy {
    enum State { case pursue, extend, evade, dying }

    let aircraft = Aircraft()
    let node: SCNNode
    var hp: Int
    let evadeChance: Double
    let burstPause: Double
    /// 0 = sloppy rookie steering, 1 = veteran precision.
    let skill: Double
    let gunSpread: Double
    var state = State.pursue
    var stateUntil: TimeInterval = 0
    var extendTarget = SIMD3<Double>.zero
    var burstUntil: TimeInterval = 0
    var nextBurst: TimeInterval = 0
    var gunTimer = 0.0
    var smoking = false
    var rng: SplitMix64

    init(spawnAround center: SIMD3<Double>, forwardHint: SIMD3<Double>, terrain: TerrainGenerator, seed: UInt64, difficulty kills: Int) {
        rng = SplitMix64(state: seed)
        node = AircraftModel.makeBandit()
        aircraft.tuning = .bandit(kills: kills)
        hp = min(3 + kills / 3, 8)
        evadeChance = min(0.002 + Double(kills) * 0.004, 0.035)
        burstPause = max(2.0, 5.5 - Double(kills) * 0.25)
        skill = min(1.0, Double(kills) / 12.0)
        gunSpread = 0.030 - 0.018 * skill
        // Spawn in the player's forward arc so the fight is in front of you.
        let base = atan2(forwardHint.x, forwardHint.z)
        let angle = base + (Double(rng.next() % 1000) / 1000 - 0.5) * 2.4
        let dist = 1200.0 + Double(rng.next() % 1000)
        let x = center.x + sin(angle) * dist
        let z = center.z + cos(angle) * dist
        let ground = max(terrain.height(x, z), 0)
        aircraft.position = SIMD3(x, max(center.y + Double(rng.next() % 400) - 200, ground + 350), z)
        // Start pointed roughly at the player.
        let to = simd_normalize(center - aircraft.position)
        let yaw = atan2(-to.x, -to.z)
        aircraft.orientation = simd_quatd(angle: yaw, axis: SIMD3(0, 1, 0))
        aircraft.speed = aircraft.tuning.cruiseMax * 0.9
        aircraft.throttle = 0.9
        sync()
    }

    var dead: Bool { state == .dying }

    func sync() {
        node.simdPosition = SIMD3<Float>(aircraft.position)
        node.simdOrientation = simd_quatf(
            ix: Float(aircraft.orientation.imag.x),
            iy: Float(aircraft.orientation.imag.y),
            iz: Float(aircraft.orientation.imag.z),
            r: Float(aircraft.orientation.real)
        )
    }

    private func unit() -> Double { Double(rng.next() % 100_000) / 100_000 }

    /// Steer toward a world point: roll the target into the vertical plane,
    /// then pull. Rookies use low gains — they wallow toward the target
    /// instead of snapping onto it.
    private func steer(toward p: SIMD3<Double>) -> FlightInput {
        let local = simd_normalize(aircraft.orientation.inverse.act(p - aircraft.position))
        var input = FlightInput()
        let ahead = -local.z
        let rollGain = 0.7 + 0.8 * skill
        let pitchGain = 2.0 + 2.0 * skill
        input.roll = min(max(atan2(local.x, max(local.y, 0.05)) * rollGain, -1), 1)
        if ahead > 0.2 {
            input.pitch = min(max(local.y * pitchGain, -0.4), 1)
        } else {
            input.pitch = 0.5 + 0.5 * skill    // target behind: committed turn
        }
        return input
    }

    /// Returns the flight input for this frame and whether guns should fire.
    func think(time: TimeInterval, player: Aircraft, terrain: TerrainGenerator) -> (FlightInput, Bool) {
        let toPlayer = player.position - aircraft.position
        let dist = simd_length(toPlayer)
        let playerAimsAtMe = dist < 700
            && simd_dot(player.forward, simd_normalize(-toPlayer)) > 0.94

        // State transitions.
        if time > stateUntil {
            state = .pursue
        }
        switch state {
        case .pursue:
            if dist < 220 {
                // Too close — break off to avoid ramming, re-attack from range.
                state = .extend
                stateUntil = time + 5
                let away = simd_normalize(SIMD3(-toPlayer.x, 0, -toPlayer.z))
                extendTarget = aircraft.position + away * 2500 + SIMD3(0, 250, 0)
            } else if playerAimsAtMe && unit() < evadeChance {
                state = .evade
                stateUntil = time + 2.5 + unit() * 1.5
            }
        case .evade:
            if !playerAimsAtMe && unit() < 0.05 { state = .pursue }
        case .extend, .dying:
            break
        }

        // Pick a target point.
        var target: SIMD3<Double>
        var throttle = 1.0
        switch state {
        case .pursue:
            // Lead the player slightly.
            target = player.position + player.forward * min(dist * 0.25, 180)
            throttle = dist > 500 ? 1.0 : 0.75
        case .extend:
            target = extendTarget
        case .evade:
            // Rolling break turn.
            target = aircraft.position + aircraft.forward * 300
                + aircraft.right * 400 * (unit() < 0.5 ? 1 : -1)
                + SIMD3(0, -80, 0)
            throttle = 0.95
        case .dying:
            var input = FlightInput()
            input.pitch = -0.35
            input.roll = 1
            aircraft.throttle = 0
            return (input, false)
        }

        // Terrain avoidance overrides everything.
        let ground = max(terrain.height(aircraft.position.x, aircraft.position.z), 0)
        let aheadPos = aircraft.position + aircraft.forward * 450
        let groundAhead = max(terrain.height(aheadPos.x, aheadPos.z), 0)
        if aircraft.position.y - ground < 180 || aheadPos.y - groundAhead < 130 {
            let flat = simd_normalize(SIMD3(aircraft.forward.x, 0, aircraft.forward.z))
            target = aircraft.position + flat * 400 + SIMD3(0, 500, 0)
            throttle = 1.0
        }

        var input = steer(toward: target)
        input.throttleUp = aircraft.throttle < throttle
        input.throttleDown = aircraft.throttle > throttle + 0.1

        // Gunnery: fire in bursts when close and aligned.
        var firing = false
        if state == .pursue, dist < 650 {
            let angleOff = acos(min(max(simd_dot(aircraft.forward, simd_normalize(toPlayer)), -1), 1))
            if angleOff < 0.10 {
                if time > nextBurst {
                    burstUntil = time + 1.1
                    nextBurst = time + burstPause + unit() * 1.5
                }
                firing = time < burstUntil
            }
        }
        return (input, firing)
    }
}

/// Bullets, bandits, damage, explosions, score.
final class CombatSystem {
    let root = SCNNode()
    private(set) var kills = 0
    private(set) var playerHP = 100
    var banditsAlive: Int { enemies.count }

    private let terrain: TerrainGenerator
    private var enemies: [Enemy] = []
    private var bullets: [Bullet] = []
    private var respawnTimes: [TimeInterval] = []
    private var playerGunTimer = 0.0
    private var enemySeed: UInt64 = 1
    private let banditTarget = 4
    var onMessage: ((String) -> Void)?
    /// Test hook (--aimbot): fire continuously with lead pursuit at the nearest bandit.
    var aimTest = false

    init(terrain: TerrainGenerator) {
        self.terrain = terrain
    }

    func activate(around player: Aircraft, time: TimeInterval) {
        playerHP = 100
        for _ in 0..<banditTarget { spawnEnemy(around: player) }
    }

    /// (east, north) offsets of live bandits relative to the player, for the radar.
    func banditOffsets(from playerPosition: SIMD3<Double>) -> [(Double, Double)] {
        enemies.map { e in
            (-(e.aircraft.position.x - playerPosition.x), -(e.aircraft.position.z - playerPosition.z))
        }
    }

    /// World positions of bandits, for the in-sky target markers.
    func banditPositions() -> [SIMD3<Double>] {
        enemies.map(\.aircraft.position)
    }

    func deactivate() {
        for e in enemies { e.node.removeFromParentNode() }
        enemies.removeAll()
        for b in bullets { b.node.removeFromParentNode() }
        bullets.removeAll()
        respawnTimes.removeAll()
    }

    func playerRespawned() {
        playerHP = 100
    }

    private func spawnEnemy(around player: Aircraft) {
        enemySeed &+= 0x9E37_79B9_7F4A_7C15
        let e = Enemy(spawnAround: player.position, forwardHint: player.forward, terrain: terrain, seed: enemySeed, difficulty: kills)
        enemies.append(e)
        root.addChildNode(e.node)
    }

    func update(dt: Double, time: TimeInterval, player: Aircraft, playerFiring: Bool) {
        // Respawns keep the fight going.
        respawnTimes.removeAll { t in
            if time > t {
                spawnEnemy(around: player)
                onMessage?("BANDIT INBOUND")
                return true
            }
            return false
        }

        // Player guns: two wing mounts, converging ~350 m ahead.
        playerGunTimer -= dt
        if (playerFiring || aimTest) && playerGunTimer <= 0 {
            playerGunTimer = 1.0 / 14.0
            var aim = player.position + player.forward * 350
            if aimTest, let target = enemies.filter({ !$0.dead }).min(by: {
                simd_distance($0.aircraft.position, player.position) < simd_distance($1.aircraft.position, player.position)
            }) {
                let flightTime = simd_distance(target.aircraft.position, player.position) / 720
                aim = target.aircraft.position + target.aircraft.forward * target.aircraft.speed * flightTime
            }
            for side in [1.0, -1.0] {
                let muzzle = player.position + player.right * (side * 2.4) + player.up * -0.1 + player.forward * 1.0
                let dir = simd_normalize(aim - muzzle)
                fire(from: muzzle, direction: dir, carrier: player.forward * player.speed, fromPlayer: true)
            }
        }

        // Enemies.
        var killedThisFrame: [Int] = []
        for (i, e) in enemies.enumerated() {
            // Rubber-band: bandits are slower than you, so anyone left far
            // behind is repositioned into your forward arc to rejoin the fight.
            if !e.dead, simd_distance(e.aircraft.position, player.position) > 3500 {
                let base = atan2(player.forward.x, player.forward.z)
                let angle = base + (Double(e.rng.next() % 1000) / 1000 - 0.5) * 1.6
                let dist = 1600.0 + Double(e.rng.next() % 600)
                let x = player.position.x + sin(angle) * dist
                let z = player.position.z + cos(angle) * dist
                let ground = max(terrain.height(x, z), 0)
                e.aircraft.position = SIMD3(x, max(player.position.y, ground + 350), z)
                let to = simd_normalize(player.position - e.aircraft.position)
                e.aircraft.orientation = simd_quatd(angle: atan2(-to.x, -to.z), axis: SIMD3(0, 1, 0))
            }

            let (input, firing) = e.think(time: time, player: player, terrain: terrain)
            e.aircraft.update(dt: dt, input: input)
            e.sync()

            if firing {
                e.gunTimer -= dt
                if e.gunTimer <= 0 {
                    e.gunTimer = 1.0 / 9.0
                    // Spread shrinks as they get better; rookies spray.
                    let lead = player.position + player.forward * player.speed * (0.15 + 0.25 * e.skill)
                    var dir = simd_normalize(lead - e.aircraft.position)
                    dir += SIMD3(e.jitter(), e.jitter(), e.jitter()) * e.gunSpread
                    let muzzle = e.aircraft.position + e.aircraft.forward * 2.5
                    fire(from: muzzle, direction: simd_normalize(dir), carrier: e.aircraft.forward * e.aircraft.speed, fromPlayer: false)
                }
            }

            // Terrain impact (both dying wrecks and misjudged pursuits).
            let ground = max(terrain.height(e.aircraft.position.x, e.aircraft.position.z), 0)
            if e.aircraft.position.y < ground + 2 {
                explosion(at: e.aircraft.position, big: true)
                killedThisFrame.append(i)
                if !e.dead {
                    kills += 1
                    onMessage?("BANDIT FLEW INTO TERRAIN")
                }
            }

            // Mid-air collision with the player.
            if !e.dead, simd_distance(e.aircraft.position, player.position) < 9 {
                explosion(at: e.aircraft.position, big: true)
                killedThisFrame.append(i)
                kills += 1
                playerHP -= 45
                onMessage?("COLLISION!")
            }
        }
        removeEnemies(at: killedThisFrame, time: time)

        // Bullets: integrate, then proximity hit-test.
        var deadBullets: [Int] = []
        for i in bullets.indices {
            bullets[i].position += bullets[i].velocity * dt
            bullets[i].ttl -= dt
            bullets[i].node.simdPosition = SIMD3<Float>(bullets[i].position)
            let p = bullets[i].position

            if bullets[i].ttl <= 0 || p.y < max(terrain.height(p.x, p.z), 0) {
                deadBullets.append(i)
                continue
            }
            if bullets[i].fromPlayer {
                for (j, e) in enemies.enumerated() where !e.dead {
                    if simd_distance(p, e.aircraft.position) < 10 {
                        deadBullets.append(i)
                        hitEnemy(j, time: time)
                        break
                    }
                }
            } else if simd_distance(p, player.position) < 6 {
                deadBullets.append(i)
                playerHP -= 5
                explosionSpark(at: player.position)
                onMessage?("TAKING FIRE — HP \(max(playerHP, 0))")
            }
        }
        for i in deadBullets.sorted(by: >) {
            bullets[i].node.removeFromParentNode()
            bullets.remove(at: i)
        }
    }

    private func hitEnemy(_ index: Int, time: TimeInterval) {
        let e = enemies[index]
        guard !e.dead else { return }
        e.hp -= 1
        explosionSpark(at: e.aircraft.position)
        if e.hp <= 2 && !e.smoking {
            e.smoking = true
            e.node.addParticleSystem(Self.smokeTrail())
        }
        if e.hp <= 0 {
            e.state = .dying
            e.stateUntil = .greatestFiniteMagnitude
            kills += 1
            onMessage?("BANDIT DOWN — \(kills) KILLS")
        }
    }

    private func removeEnemies(at indices: [Int], time: TimeInterval) {
        for i in Set(indices).sorted(by: >) {
            enemies[i].node.removeFromParentNode()
            enemies.remove(at: i)
            respawnTimes.append(time + 9)
        }
    }

    private func fire(from origin: SIMD3<Double>, direction: SIMD3<Double>, carrier: SIMD3<Double>, fromPlayer: Bool) {
        let tracer = SCNNode(geometry: Self.tracerGeometry(player: fromPlayer))
        tracer.simdPosition = SIMD3<Float>(origin)
        let velocity = direction * 720 + carrier
        tracer.simdLook(at: SIMD3<Float>(origin + velocity), up: SIMD3<Float>(0, 1, 0), localFront: SIMD3<Float>(0, 0, -1))
        tracer.castsShadow = false
        root.addChildNode(tracer)
        bullets.append(Bullet(node: tracer, position: origin, velocity: velocity, ttl: 1.3, fromPlayer: fromPlayer))
    }

    // MARK: - Effects

    private static let playerTracer: SCNGeometry = makeTracer(NSColor(red: 1, green: 0.85, blue: 0.4, alpha: 1))
    private static let enemyTracer: SCNGeometry = makeTracer(NSColor(red: 1, green: 0.42, blue: 0.28, alpha: 1))

    private static func tracerGeometry(player: Bool) -> SCNGeometry {
        player ? playerTracer : enemyTracer
    }

    private static func makeTracer(_ color: NSColor) -> SCNGeometry {
        let g = SCNBox(width: 0.14, height: 0.14, length: 3.2, chamferRadius: 0)
        let m = SCNMaterial()
        m.lightingModel = .constant
        m.diffuse.contents = color
        m.emission.contents = color
        g.firstMaterial = m
        return g
    }

    private func explosionSpark(at p: SIMD3<Double>) {
        let flash = SCNNode(geometry: SCNSphere(radius: 1.1))
        let m = SCNMaterial()
        m.lightingModel = .constant
        m.emission.contents = NSColor(red: 1, green: 0.75, blue: 0.3, alpha: 1)
        flash.geometry?.firstMaterial = m
        flash.simdPosition = SIMD3<Float>(p)
        root.addChildNode(flash)
        flash.runAction(.sequence([
            .group([.scale(to: 2.4, duration: 0.12), .fadeOut(duration: 0.14)]),
            .removeFromParentNode(),
        ]))
    }

    private func explosion(at p: SIMD3<Double>, big: Bool) {
        let flash = SCNNode(geometry: SCNSphere(radius: 2.5))
        let m = SCNMaterial()
        m.lightingModel = .constant
        m.emission.contents = NSColor(red: 1, green: 0.55, blue: 0.15, alpha: 1)
        flash.geometry?.firstMaterial = m
        flash.simdPosition = SIMD3<Float>(p)
        root.addChildNode(flash)
        flash.runAction(.sequence([
            .group([.scale(to: big ? 9 : 4, duration: 0.4), .fadeOut(duration: 0.5)]),
            .removeFromParentNode(),
        ]))

        let burst = SCNNode()
        burst.simdPosition = SIMD3<Float>(p)
        let ps = Self.smokeBurst()
        burst.addParticleSystem(ps)
        root.addChildNode(burst)
        burst.runAction(.sequence([.wait(duration: 4), .removeFromParentNode()]))
    }

    private static let particleImage: NSImage = {
        let size = 64
        let image = NSImage(size: NSSize(width: size, height: size))
        image.lockFocus()
        if let ctx = NSGraphicsContext.current?.cgContext {
            let colors = [
                CGColor(red: 1, green: 1, blue: 1, alpha: 0.85),
                CGColor(red: 1, green: 1, blue: 1, alpha: 0),
            ] as CFArray
            if let grad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) {
                ctx.drawRadialGradient(
                    grad,
                    startCenter: CGPoint(x: 32, y: 32), startRadius: 0,
                    endCenter: CGPoint(x: 32, y: 32), endRadius: 30,
                    options: []
                )
            }
        }
        image.unlockFocus()
        return image
    }()

    private static func smokeTrail() -> SCNParticleSystem {
        let ps = SCNParticleSystem()
        ps.particleImage = particleImage
        ps.birthRate = 28
        ps.particleLifeSpan = 1.4
        ps.particleSize = 2.6
        ps.particleSizeVariation = 1.2
        ps.particleVelocity = 4
        ps.spreadingAngle = 12
        ps.emittingDirection = SCNVector3(0, 0.3, 1)
        ps.particleColor = NSColor(white: 0.22, alpha: 0.7)
        ps.blendMode = .alpha
        return ps
    }

    private static func smokeBurst() -> SCNParticleSystem {
        let ps = SCNParticleSystem()
        ps.particleImage = particleImage
        ps.birthRate = 260
        ps.emissionDuration = 0.18
        ps.loops = false
        ps.particleLifeSpan = 1.6
        ps.particleLifeSpanVariation = 0.5
        ps.particleSize = 5
        ps.particleSizeVariation = 3
        ps.particleVelocity = 26
        ps.particleVelocityVariation = 14
        ps.spreadingAngle = 180
        ps.particleColor = NSColor(red: 1.0, green: 0.5, blue: 0.2, alpha: 0.9)
        ps.blendMode = .additive
        return ps
    }
}

private extension Enemy {
    func jitter() -> Double { (Double(rng.next() % 2000) / 1000) - 1 }
}
