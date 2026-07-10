// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "GeepusAssistant",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(name: "AssistantShared", targets: ["AssistantShared"]),
        .executable(name: "AssistantDaemon", targets: ["AssistantDaemon"]),
        .executable(name: "AssistantUI", targets: ["AssistantUI"])
    ],
    targets: [
        .target(
            name: "AssistantShared"
        ),
        .executableTarget(
            name: "AssistantDaemon",
            dependencies: ["AssistantShared"]
        ),
        .executableTarget(
            name: "AssistantUI",
            dependencies: ["AssistantShared"]
        ),
        .testTarget(
            name: "AssistantSharedTests",
            dependencies: ["AssistantShared"]
        )
    ]
)
