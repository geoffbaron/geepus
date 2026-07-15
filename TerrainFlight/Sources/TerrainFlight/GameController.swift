import Foundation
import SceneKit
import simd
import SpriteKit

enum GameMode {
    case freeFlight
    case dogfight
}

final class GameController: NSObject, SCNSceneRendererDelegate {
    let scene = SCNScene()
    let terrain: TerrainGenerator
    let weather: Weather
    let aircraft = Aircraft()
    let planeNode = SCNNode()          // rig; the visible model is a swappable child
    let cameraNode = SCNNode()
    let terrainRoot = SCNNode()
    let hud: HUD
    weak var view: GameView?

    private(set) var mode = GameMode.freeFlight
    private(set) var vehicle = Vehicle.cessna
    private var playerModel = Vehicle.cessna.makeNode()
    let combat: CombatSystem
    var cockpitView = false {
        didSet {
            playerModel.isHidden = cockpitView
            refreshButtons()
        }
    }

    private func refreshButtons() {
        let modeText = mode == .dogfight ? "DOGFIGHT" : "FREE FLIGHT"
        let viewText = cockpitView ? "COCKPIT" : "CHASE"
        let planeText = vehicle.displayName
        DispatchQueue.main.async { [hud] in hud.setButtons(mode: modeText, view: viewText, plane: planeText) }
    }

    func setVehicle(_ v: Vehicle) {
        vehicle = v
        playerModel.removeFromParentNode()
        playerModel = v.makeNode()
        playerModel.isHidden = cockpitView
        planeNode.addChildNode(playerModel)
        aircraft.tuning = v.tuning
        // Don't drop straight into a stall when stepping up to a faster type.
        aircraft.speed = max(aircraft.speed, v.tuning.stallSpeed + 20)
        refreshButtons()
        hud.flash("PLANE: \(v.displayName)", at: ProcessInfo.processInfo.systemUptime, for: 1.5)
    }

    /// Click handling for the HUD buttons (point is in overlay-scene coords).
    func handleClick(at point: CGPoint) {
        switch hud.buttonName(at: point) {
        case HUD.modeButtonName:
            setMode(mode == .freeFlight ? .dogfight : .freeFlight)
        case HUD.viewButtonName:
            cockpitView.toggle()
        case HUD.respawnButtonName:
            respawnPlayer()
        case HUD.planeButtonName:
            setVehicle(vehicle.next)
        default:
            break
        }
    }

    private let clouds: CloudField
    private let gustNoise: PerlinNoise
    private var loaded = [ChunkKey: SCNNode]()
    private var pending = Set<ChunkKey>()
    private let genQueue = DispatchQueue(label: "terrain-gen", qos: .userInitiated, attributes: .concurrent)
    private var lastTime: TimeInterval?
    private var lastStreamTime: TimeInterval = -10
    private var lastRadarLandTime: TimeInterval = -10
    private var radarLandBusy = false
    private var smoothedLookTarget: SIMD3<Double>?
    private let viewRadius = 6      // chunks (~11.5 km)
    private let dropRadius = 8

    init(seed: UInt64, viewSize: CGSize) {
        terrain = TerrainGenerator(seed: seed)
        weather = Weather(seed: seed)
        clouds = CloudField(seed: seed, coverage: weather.coverage, wind: weather.windVector)
        gustNoise = PerlinNoise(seed: seed &+ 99)
        hud = HUD(size: viewSize)
        combat = CombatSystem(terrain: terrain)
        super.init()
        combat.onMessage = { [weak self] text in
            guard let self else { return }
            let now = ProcessInfo.processInfo.systemUptime
            DispatchQueue.main.async { self.hud.flash(text, at: now, for: 2) }
        }
        setupScene()
        aircraft.reset(over: terrain)
        syncPlaneNode()
        // Preload the spawn area synchronously-ish so there's ground on frame one.
        streamChunks(force: true)
        clouds.update(around: aircraft.position)
    }

    private func setupScene() {
        // Physically-based sky drives the background, IBL, and sun direction.
        let sunDir = SkyBuilder.apply(to: scene, weather: weather)

        let hz = SkyBuilder.horizonColor
        scene.fogColor = NSColor(red: hz.x, green: hz.y, blue: hz.z, alpha: 1)
        // Fog must fully swallow the edge of the streamed chunk disk (radius 6
        // chunks ≈ 11.5 km, nearest new-chunk corner ≈ 10.2 km) so nothing pops.
        scene.fogStartDistance = 4000
        scene.fogEndDistance = 9800

        let sun = SCNNode()
        sun.light = SCNLight()
        sun.light?.type = .directional
        sun.light?.intensity = 950
        sun.light?.color = NSColor(red: 1, green: 0.95, blue: 0.86, alpha: 1)
        sun.simdLook(at: sunDir, up: SIMD3(0, 1, 0), localFront: SIMD3(0, 0, -1))
        scene.rootNode.addChildNode(sun)

        let ambient = SCNNode()
        ambient.light = SCNLight()
        ambient.light?.type = .ambient
        ambient.light?.intensity = 340
        ambient.light?.color = NSColor(red: 0.68, green: 0.74, blue: 0.85, alpha: 1)
        scene.rootNode.addChildNode(ambient)

        // Infinite deep-ocean floor: opaque, and the exact color the chunk
        // water fades to, so the streamed/unstreamed boundary is invisible.
        let water = SCNFloor()
        water.reflectivity = 0
        let waterMat = TerrainMesh.waterMaterial()
        let deep = TerrainMesh.deepWater
        waterMat.diffuse.contents = NSColor(
            red: CGFloat(deep.x), green: CGFloat(deep.y), blue: CGFloat(deep.z), alpha: 1
        )
        water.firstMaterial = waterMat
        let waterNode = SCNNode(geometry: water)
        waterNode.position.y = -0.6
        scene.rootNode.addChildNode(waterNode)

        scene.rootNode.addChildNode(terrainRoot)
        scene.rootNode.addChildNode(clouds.root)
        planeNode.addChildNode(playerModel)
        scene.rootNode.addChildNode(planeNode)
        scene.rootNode.addChildNode(combat.root)

        let camera = SCNCamera()
        camera.zNear = 1
        camera.zFar = 30000
        camera.fieldOfView = 70
        camera.wantsHDR = true
        camera.bloomIntensity = 0.4
        camera.bloomThreshold = 0.9
        cameraNode.camera = camera
        scene.rootNode.addChildNode(cameraNode)
        cameraNode.position = SCNVector3(0, aircraft.position.y + 8, 24)
    }

    func respawnPlayer() {
        aircraft.reset(over: terrain)
        combat.playerRespawned()
        smoothedLookTarget = nil
        hud.flash("RESPAWNED", at: ProcessInfo.processInfo.systemUptime, for: 2)
    }

    func handleKeyTap(_ code: UInt16) {
        switch code {
        case Key.r:
            respawnPlayer()
        case Key.h:
            hud.showHelp.toggle()
        case Key.g:
            setMode(mode == .freeFlight ? .dogfight : .freeFlight)
        case Key.c:
            cockpitView.toggle()
            hud.flash(cockpitView ? "COCKPIT VIEW" : "CHASE VIEW", at: ProcessInfo.processInfo.systemUptime, for: 1.5)
        case Key.v:
            setVehicle(vehicle.next)
        default:
            break
        }
    }

    func setMode(_ newMode: GameMode) {
        guard newMode != mode else { return }
        mode = newMode
        let now = ProcessInfo.processInfo.systemUptime

        switch newMode {
        case .dogfight:
            combat.activate(around: aircraft, time: now)
            hud.flash("DOGFIGHT — 4 BANDITS INBOUND. SPACE TO FIRE.", at: now, for: 4)
        case .freeFlight:
            combat.deactivate()
            hud.flash("FREE FLIGHT", at: now, for: 2)
        }
        refreshButtons()
    }

    // MARK: - Per-frame

    func renderer(_ renderer: SCNSceneRenderer, updateAtTime time: TimeInterval) {
        let dt = min(lastTime.map { time - $0 } ?? 1.0 / 60.0, 1.0 / 20.0)
        lastTime = time

        var input = FlightInput()
        if let v = view {
            if v.isDown(Key.down) { input.pitch += 1 }
            if v.isDown(Key.up) { input.pitch -= 1 }
            if v.isDown(Key.right) { input.roll += 1 }
            if v.isDown(Key.left) { input.roll -= 1 }
            if v.isDown(Key.d) { input.yaw += 1 }
            if v.isDown(Key.a) { input.yaw -= 1 }
            input.throttleUp = v.isDown(Key.w)
            input.throttleDown = v.isDown(Key.s)
        }

        // Weather evolves: wind veers and strengthens over minutes, haze
        // thickens and clears. (Slow noise, cheap per frame.)
        let windDirNow = weather.windDirection + 0.7 * gustNoise.noise(time * 0.0032, 313.1)
        let windSpeedNow = max(0.5, weather.windSpeed * (1 + 0.55 * gustNoise.noise(time * 0.0045, 707.7)))
        let windNow = SIMD3<Double>(sin(windDirNow), 0, cos(windDirNow)) * windSpeedNow
        let fogN = 0.5 + 0.5 * gustNoise.noise(time * 0.0038, 99.9)
        let fogTarget = 6800 + 3000 * fogN
        let fogNow = scene.fogEndDistance + (CGFloat(fogTarget) - scene.fogEndDistance) * CGFloat(min(1, dt * 0.05))
        scene.fogEndDistance = fogNow
        scene.fogStartDistance = fogNow * 0.42

        // Steady wind plus slow gusts, and a faint turbulence wobble.
        let gustScale = windSpeedNow * 0.35
        let gust = SIMD3<Double>(
            gustNoise.noise(time * 0.13, 3.7) * gustScale,
            gustNoise.noise(time * 0.11, 41.2) * gustScale * 0.35,
            gustNoise.noise(time * 0.12, 87.9) * gustScale
        )
        let wobbleScale = windSpeedNow * 0.0005
        aircraft.update(
            dt: dt,
            input: input,
            wind: windNow + gust,
            wobblePitch: gustNoise.noise(time * 0.8, 11.1) * wobbleScale,
            wobbleRoll: gustNoise.noise(time * 0.7, 55.5) * wobbleScale * 1.6
        )

        // Combat runs its bullets, bandits, and damage in dogfight mode.
        if mode == .dogfight {
            combat.update(
                dt: dt, time: time, player: aircraft,
                playerFiring: view?.isDown(Key.space) ?? false
            )
            if combat.playerHP <= 0 {
                aircraft.reset(over: terrain)
                combat.playerRespawned()
                smoothedLookTarget = nil
                hud.flash("SHOT DOWN! Respawning…", at: time)
            }
        }

        // Terrain / water collision.
        let ground = terrain.height(aircraft.position.x, aircraft.position.z)
        let floorY = max(ground, 0)
        if aircraft.position.y < floorY + 2.5 {
            let wasWater = ground < 0
            aircraft.reset(over: terrain)
            combat.playerRespawned()
            smoothedLookTarget = nil
            hud.flash(wasWater ? "SPLASH! Respawning…" : "CRUNCH! Respawning…", at: time)
        }

        syncPlaneNode()
        updateCamera(dt: dt)

        if time - lastStreamTime > 0.25 {
            lastStreamTime = time
            // Chunk bookkeeping lives on the main thread; the render delegate doesn't.
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.streamChunks(force: false)
                self.clouds.update(around: self.aircraft.position)
            }
        }
        if time - lastRadarLandTime > 2.0 {
            lastRadarLandTime = time
            regenerateRadarLand()
        }

        let hudSpeed = aircraft.speed
        let hudAlt = aircraft.position.y
        let hudHdg = aircraft.headingDegrees
        let hudThr = aircraft.throttle
        var windFrom = atan2(-sin(windDirNow), -cos(windDirNow)) * 180 / .pi
        if windFrom < 0 { windFrom += 360 }
        let windText = String(format: "WIND %03d°/%.0f", Int(windFrom) % 360, windSpeedNow)
        let combatText: String? = mode == .dogfight
            ? "HP \(max(combat.playerHP, 0))   KILLS \(combat.kills)   BANDITS \(combat.banditsAlive)"
            : nil
        let fwd = aircraft.forward
        let headingRad = atan2(-fwd.x, -fwd.z)
        let offsets = mode == .dogfight ? combat.banditOffsets(from: aircraft.position) : []

        // Project bandits into screen space for the in-sky target markers.
        var targetMarkers: [HUD.TargetMarker] = []
        if mode == .dogfight {
            let camPos = cameraNode.simdWorldPosition
            let camFront = cameraNode.simdWorldFront
            for pos in combat.banditPositions() {
                let pf = SIMD3<Float>(pos)
                let proj = renderer.projectPoint(SCNVector3(pf))
                let inFront = simd_dot(pf - camPos, camFront) > 0
                targetMarkers.append(HUD.TargetMarker(
                    x: Double(proj.x), y: Double(proj.y),
                    inFront: inFront,
                    distance: simd_distance(pos, aircraft.position)
                ))
            }
        }

        DispatchQueue.main.async { [hud] in
            hud.update(speed: hudSpeed, altitude: hudAlt, ground: max(ground, 0), heading: hudHdg, throttle: hudThr, wind: windText, combat: combatText, time: time)
            hud.updateRadar(headingRad: headingRad, banditOffsets: offsets)
            hud.updateTargetMarkers(targetMarkers)
        }
    }

    private var planeOrientationF: simd_quatf {
        simd_quatf(
            ix: Float(aircraft.orientation.imag.x),
            iy: Float(aircraft.orientation.imag.y),
            iz: Float(aircraft.orientation.imag.z),
            r: Float(aircraft.orientation.real)
        )
    }

    private func syncPlaneNode() {
        planeNode.simdPosition = SIMD3<Float>(aircraft.position)
        planeNode.simdOrientation = planeOrientationF
    }

    private func updateCamera(dt: Double) {
        if cockpitView {
            // Rigid pilot's-eye camera: rolls and pitches with the airframe.
            let eye = aircraft.position + aircraft.orientation.act(SIMD3(0, 0.72, -0.35))
            cameraNode.simdPosition = SIMD3<Float>(eye)
            cameraNode.simdOrientation = planeOrientationF
            cameraNode.camera?.fieldOfView = min(68 + CGFloat(aircraft.speed) * 0.03, 77)
            smoothedLookTarget = nil
            return
        }

        // Chase camera: sit behind and above, keep world-up so banking is visible.
        let fwd = aircraft.forward
        let flatFwd = simd_normalize(SIMD3(fwd.x, 0, fwd.z))
        // Pull the camera back a bit at jet speeds.
        let chaseDist = 22 + max(0, aircraft.speed - 150) * 0.05
        let desired = aircraft.position - flatFwd * chaseDist + SIMD3<Double>(0, 7.5 + chaseDist * 0.06, 0)
        let current = SIMD3<Double>(
            Double(cameraNode.simdPosition.x),
            Double(cameraNode.simdPosition.y),
            Double(cameraNode.simdPosition.z)
        )
        let posBlend = 1 - exp(-dt * 3.6)
        let next = current + (desired - current) * posBlend
        cameraNode.simdPosition = SIMD3<Float>(next)

        // The look target is smoothed too, so pitch/roll starts don't snap the view.
        let rawTarget = aircraft.position + fwd * 30
        var target = smoothedLookTarget ?? rawTarget
        target += (rawTarget - target) * (1 - exp(-dt * 6.0))
        smoothedLookTarget = target
        cameraNode.simdLook(at: SIMD3<Float>(target), up: SIMD3<Float>(0, 1, 0), localFront: SIMD3<Float>(0, 0, -1))

        // A touch of speed-based FOV for a sense of pace.
        cameraNode.camera?.fieldOfView = min(66 + CGFloat(aircraft.speed) * 0.05, 80)
    }

    /// Renders a north-up terrain snapshot around the player for the radar.
    /// East is -X in this world, so the horizontal texture axis is flipped.
    private func regenerateRadarLand() {
        guard !radarLandBusy else { return }
        radarLandBusy = true
        let span = HUD.radarRange
        let px = aircraft.position.x
        let pz = aircraft.position.z
        let n = 48
        genQueue.async { [terrain, weak self] in
            var pixels = [UInt8](repeating: 255, count: n * n * 4)
            for iy in 0..<n {
                let wz = pz - span + 2 * span * Double(iy) / Double(n - 1)   // row 0 = north
                for ix in 0..<n {
                    let wx = px + span - 2 * span * Double(ix) / Double(n - 1) // col 0 = west
                    let info = terrain.sample(wx, wz)
                    let h = info.height
                    let c: (Double, Double, Double)
                    if h <= 0 {
                        c = (0.10, 0.25, 0.42)
                    } else if info.mask > 0.3 && info.surface > h {
                        c = (0.16, 0.34, 0.48)   // lakes and rivers
                    } else if h < 8 {
                        c = (0.72, 0.65, 0.48)
                    } else if h < 600 {
                        c = (0.32, 0.45, 0.24)
                    } else if h < 1300 {
                        c = (0.48, 0.44, 0.38)
                    } else {
                        c = (0.85, 0.87, 0.90)
                    }
                    let o = (iy * n + ix) * 4
                    pixels[o] = UInt8(c.0 * 255)
                    pixels[o + 1] = UInt8(c.1 * 255)
                    pixels[o + 2] = UInt8(c.2 * 255)
                }
            }
            let cg = pixels.withUnsafeMutableBytes { buf -> CGImage? in
                guard let ctx = CGContext(
                    data: buf.baseAddress, width: n, height: n,
                    bitsPerComponent: 8, bytesPerRow: n * 4,
                    space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
                ) else { return nil }
                return ctx.makeImage()
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.radarLandBusy = false
                if let cg { self.hud.setRadarLand(SKTexture(cgImage: cg)) }
            }
        }
    }

    // MARK: - Chunk streaming

    private func streamChunks(force: Bool) {
        let size = TerrainMesh.chunkSize
        let pcx = Int(floor(aircraft.position.x / size))
        let pcz = Int(floor(aircraft.position.z / size))

        var wanted = [ChunkKey]()
        for dz in -viewRadius...viewRadius {
            for dx in -viewRadius...viewRadius {
                if dx * dx + dz * dz <= viewRadius * viewRadius {
                    wanted.append(ChunkKey(cx: pcx + dx, cz: pcz + dz))
                }
            }
        }
        wanted.sort {
            let a = ($0.cx - pcx) * ($0.cx - pcx) + ($0.cz - pcz) * ($0.cz - pcz)
            let b = ($1.cx - pcx) * ($1.cx - pcx) + ($1.cz - pcz) * ($1.cz - pcz)
            return a < b
        }

        for key in wanted where loaded[key] == nil && !pending.contains(key) {
            pending.insert(key)
            let build = { [terrain] in TerrainMesh.buildChunk(key, terrain: terrain) }
            // Even on a forced preload, only the innermost chunks block launch;
            // the rest stream in behind the fog.
            let dx = key.cx - pcx, dz = key.cz - pcz
            if force && dx * dx + dz * dz <= 4 {
                let node = build()
                terrainRoot.addChildNode(node)
                loaded[key] = node
                pending.remove(key)
            } else {
                genQueue.async { [weak self] in
                    let node = build()
                    DispatchQueue.main.async {
                        guard let self else { return }
                        self.pending.remove(key)
                        guard self.loaded[key] == nil else { return }
                        node.opacity = 0
                        self.terrainRoot.addChildNode(node)
                        node.runAction(.fadeIn(duration: 0.5))
                        self.loaded[key] = node
                    }
                }
            }
        }

        // Drop chunks that fell far behind.
        for (key, node) in loaded {
            let dx = key.cx - pcx, dz = key.cz - pcz
            if dx * dx + dz * dz > dropRadius * dropRadius {
                node.removeFromParentNode()
                loaded[key] = nil
            }
        }
    }
}
