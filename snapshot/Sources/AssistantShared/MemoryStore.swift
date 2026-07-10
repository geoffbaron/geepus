import Foundation

public struct MemoryEntry: Codable, Sendable, Identifiable {
    public let id: UUID
    public let timestamp: Date
    public let projectID: String
    public let profileID: UUID
    public let text: String

    public init(id: UUID = UUID(), timestamp: Date = Date(), projectID: String, profileID: UUID, text: String) {
        self.id = id
        self.timestamp = timestamp
        self.projectID = projectID
        self.profileID = profileID
        self.text = text
    }
}

public enum MemoryRule: String, Codable, Sendable {
    case noSecrets
    case profileIsolated
    case projectIsolated
}

public struct MemoryPolicy: Codable, Sendable {
    public let rules: [MemoryRule]

    public init(rules: [MemoryRule] = [.noSecrets, .profileIsolated, .projectIsolated]) {
        self.rules = rules
    }
}

public actor MemoryStore {
    private let url: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(baseDirectory: URL) throws {
        let directory = baseDirectory.appendingPathComponent("memory", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        self.url = directory.appendingPathComponent("memory.json")
        decoder.dateDecodingStrategy = .iso8601
        encoder.dateEncodingStrategy = .iso8601

        if !FileManager.default.fileExists(atPath: url.path) {
            let empty = try encoder.encode([MemoryEntry]())
            try empty.write(to: url)
        }
    }

    public func append(entry: MemoryEntry, policy: MemoryPolicy = MemoryPolicy()) throws {
        var entries = try load()
        var text = entry.text
        if policy.rules.contains(.noSecrets) {
            text = SecretRedactor.redact(text)
        }

        entries.append(MemoryEntry(
            id: entry.id,
            timestamp: entry.timestamp,
            projectID: entry.projectID,
            profileID: entry.profileID,
            text: text
        ))
        let data = try encoder.encode(entries)
        try data.write(to: url)
    }

    public func entries(projectID: String, profileID: UUID) throws -> [MemoryEntry] {
        try load().filter { $0.projectID == projectID && $0.profileID == profileID }
    }

    private func load() throws -> [MemoryEntry] {
        let data = try Data(contentsOf: url)
        return try decoder.decode([MemoryEntry].self, from: data)
    }
}

public enum SecretRedactor {
    private static let patterns = [
        #"(?i)api[_-]?key\s*[:=]\s*[A-Za-z0-9_\-]{8,}"#,
        #"(?i)secret\s*[:=]\s*[A-Za-z0-9_\-]{8,}"#,
        #"(?i)token\s*[:=]\s*[A-Za-z0-9_\-]{8,}"#,
        #"(?i)password\s*[:=]\s*\S+"#
    ]

    public static func redact(_ text: String) -> String {
        var output = text
        for pattern in patterns {
            output = output.replacingOccurrences(
                of: pattern,
                with: "[REDACTED]",
                options: .regularExpression
            )
        }
        return output
    }
}
