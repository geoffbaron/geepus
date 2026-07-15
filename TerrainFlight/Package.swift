// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "TerrainFlight",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "TerrainFlight",
            path: "Sources/TerrainFlight"
        )
    ]
)
