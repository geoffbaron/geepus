import CryptoKit
import Foundation
import Security

public struct AppSettings: Codable, Sendable {
    public var activeProfileID: UUID?
    public var profiles: [IdentityProfile]
    public var modelSelection: ModelSelection
    public var runtime: RuntimeConfig
    public var apiBaseURL: String
    public var apiModel: String

    public init(
        activeProfileID: UUID? = nil,
        profiles: [IdentityProfile],
        modelSelection: ModelSelection,
        runtime: RuntimeConfig,
        apiBaseURL: String,
        apiModel: String
    ) {
        self.activeProfileID = activeProfileID
        self.profiles = profiles
        self.modelSelection = modelSelection
        self.runtime = runtime
        self.apiBaseURL = apiBaseURL
        self.apiModel = apiModel
    }

    public static func defaultSettings(workspace: String) -> AppSettings {
        let work = IdentityProfile(
            name: "Work",
            kind: .work,
            policy: ProfilePolicy(
                readRoots: [workspace],
                writeRoots: [workspace],
                workspaceRoot: workspace,
                shellAllowlist: ["git", "swift", "xcodebuild", "ls", "cat", "echo"],
                domainAllowlist: [DomainRule(host: "developer.apple.com")],
                allowExternalAppAutomation: [],
                budgets: .conservativeDefaults
            )
        )

        let personal = IdentityProfile(
            name: "Personal",
            kind: .personal,
            policy: ProfilePolicy(
                readRoots: [workspace],
                writeRoots: [workspace],
                workspaceRoot: workspace,
                shellAllowlist: ["git", "swift", "ls", "cat", "echo"],
                domainAllowlist: [],
                allowExternalAppAutomation: [],
                budgets: .conservativeDefaults
            )
        )

        return AppSettings(
            activeProfileID: work.id,
            profiles: [work, personal],
            modelSelection: ModelSelection(mode: .offline, backend: .mlx, modelIdentifier: "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit"),
            runtime: RuntimeConfig(),
            apiBaseURL: "https://api.openai.com",
            apiModel: "gpt-4.1-mini"
        )
    }

    private enum CodingKeys: String, CodingKey {
        case activeProfileID
        case profiles
        case modelSelection
        case runtime
        case apiBaseURL
        case apiModel
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.activeProfileID = try container.decodeIfPresent(UUID.self, forKey: .activeProfileID)
        self.profiles = try container.decode([IdentityProfile].self, forKey: .profiles)
        self.modelSelection = try container.decode(ModelSelection.self, forKey: .modelSelection)
        self.runtime = try container.decode(RuntimeConfig.self, forKey: .runtime)
        self.apiBaseURL = try container.decodeIfPresent(String.self, forKey: .apiBaseURL) ?? "https://api.openai.com"
        self.apiModel = try container.decodeIfPresent(String.self, forKey: .apiModel) ?? "gpt-4.1-mini"
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(activeProfileID, forKey: .activeProfileID)
        try container.encode(profiles, forKey: .profiles)
        try container.encode(modelSelection, forKey: .modelSelection)
        try container.encode(runtime, forKey: .runtime)
        try container.encode(apiBaseURL, forKey: .apiBaseURL)
        try container.encode(apiModel, forKey: .apiModel)
    }
}

public final class SecureConfigStore: Sendable {
    private let settingsURL: URL
    private let service = "com.geepus.assistant.settings"
    private let account = "encryption-key"
    private let localKeyID = "settings-encryption-key"

    public init(baseDirectory: URL) throws {
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)
        self.settingsURL = baseDirectory.appendingPathComponent("settings.enc")
    }

    public func load(defaults: @autoclosure () -> AppSettings) throws -> AppSettings {
        guard FileManager.default.fileExists(atPath: settingsURL.path) else {
            let settings = defaults()
            try save(settings)
            return settings
        }

        let encrypted = try Data(contentsOf: settingsURL)

        if let keyData = try existingKeyData(), let settings = try decryptSettings(encrypted: encrypted, keyData: keyData) {
            return settings
        }

        if let keychainData = try? KeychainStore.read(service: service, account: account),
           let migrated = try decryptSettings(encrypted: encrypted, keyData: keychainData) {
            try? SecretMaterialFileStore.write(keychainData, id: localKeyID)
            return migrated
        }

        throw NSError(domain: "SecureConfigStore", code: 2, userInfo: [NSLocalizedDescriptionKey: "Unable to decrypt settings"])
    }

    public func save(_ settings: AppSettings) throws {
        let keyData = try keyData()
        let plaintext = try JSONEncoder().encode(settings)
        let sealedBox = try AES.GCM.seal(plaintext, using: SymmetricKey(data: keyData))
        guard let combined = sealedBox.combined else {
            throw NSError(domain: "SecureConfigStore", code: 1, userInfo: [NSLocalizedDescriptionKey: "encryption failed"])
        }
        try combined.write(to: settingsURL)
    }

    private func existingKeyData() throws -> Data? {
        if let local = try SecretMaterialFileStore.read(id: localKeyID) {
            return local
        }
        return nil
    }

    private func keyData() throws -> Data {
        if let existing = try existingKeyData() {
            return existing
        }

        if let keychainData = try? KeychainStore.read(service: service, account: account) {
            try? SecretMaterialFileStore.write(keychainData, id: localKeyID)
            return keychainData
        }

        let key = SymmetricKey(size: .bits256)
        let value = key.withUnsafeBytes { Data($0) }
        try SecretMaterialFileStore.write(value, id: localKeyID)
        try? KeychainStore.store(value, service: service, account: account)
        return value
    }

    private func decryptSettings(encrypted: Data, keyData: Data) throws -> AppSettings? {
        do {
            let sealedBox = try AES.GCM.SealedBox(combined: encrypted)
            let plaintext = try AES.GCM.open(sealedBox, using: SymmetricKey(data: keyData))
            return try JSONDecoder().decode(AppSettings.self, from: plaintext)
        } catch {
            return nil
        }
    }
}
