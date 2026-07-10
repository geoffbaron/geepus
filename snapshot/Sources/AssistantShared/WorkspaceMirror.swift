import Foundation

public struct MirrorSnapshot: Codable, Sendable {
    public let id: UUID
    public let createdAt: Date
    public let mirrorPath: String

    public init(id: UUID = UUID(), createdAt: Date = Date(), mirrorPath: String) {
        self.id = id
        self.createdAt = createdAt
        self.mirrorPath = mirrorPath
    }
}

public final class WorkspaceMirror: Sendable {
    public let originalWorkspace: URL
    public let mirrorRoot: URL

    public init(originalWorkspace: URL, mirrorBase: URL, runID: UUID) throws {
        self.originalWorkspace = originalWorkspace
        self.mirrorRoot = mirrorBase.appendingPathComponent("workspace_mirror/\(runID.uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: mirrorRoot, withIntermediateDirectories: true)
    }

    public func initializeMirror() throws {
        let fm = FileManager.default
        let contents = try fm.contentsOfDirectory(atPath: originalWorkspace.path)
        for item in contents {
            let src = originalWorkspace.appendingPathComponent(item)
            let dst = mirrorRoot.appendingPathComponent(item)
            if fm.fileExists(atPath: dst.path) {
                try fm.removeItem(at: dst)
            }
            try fm.copyItem(at: src, to: dst)
        }
    }

    public func write(relativePath: String, content: String) throws {
        let destination = mirrorRoot.appendingPathComponent(relativePath)
        let parent = destination.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        try content.data(using: .utf8)?.write(to: destination)
    }

    public func read(relativePath: String) throws -> String {
        let target = mirrorRoot.appendingPathComponent(relativePath)
        let data = try Data(contentsOf: target)
        return String(data: data, encoding: .utf8) ?? ""
    }

    public func snapshot() -> MirrorSnapshot {
        MirrorSnapshot(mirrorPath: mirrorRoot.path)
    }

    public func writeBackIfChecksPass(testResult: ExecutionResult, lintResult: ExecutionResult) throws {
        guard testResult.success, lintResult.success else {
            throw NSError(domain: "WorkspaceMirror", code: 1, userInfo: [NSLocalizedDescriptionKey: "Validation failed; write-back denied"])
        }

        let fm = FileManager.default
        let mirroredContents = try fm.contentsOfDirectory(atPath: mirrorRoot.path)
        for item in mirroredContents {
            let src = mirrorRoot.appendingPathComponent(item)
            let dst = originalWorkspace.appendingPathComponent(item)

            if fm.fileExists(atPath: dst.path) {
                try fm.removeItem(at: dst)
            }
            try fm.copyItem(at: src, to: dst)
        }
    }

    public func rollback() throws {
        try FileManager.default.removeItem(at: mirrorRoot)
    }
}
