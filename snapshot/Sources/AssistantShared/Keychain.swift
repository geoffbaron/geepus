import Foundation
import Security

enum KeychainStore {
    static func store(_ value: Data, service: String, account: String) throws {
        let baseQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]

        SecItemDelete(baseQuery as CFDictionary)

        var addQuery = baseQuery
        addQuery[kSecValueData as String] = value

        let status = SecItemAdd(addQuery as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: "KeychainStore", code: Int(status), userInfo: [NSLocalizedDescriptionKey: "Failed to store keychain item"])
        }
    }

    static func read(service: String, account: String) throws -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess, let data = item as? Data else {
            throw NSError(domain: "KeychainStore", code: Int(status), userInfo: [NSLocalizedDescriptionKey: "Failed to read keychain item"])
        }
        return data
    }

    static func delete(service: String, account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
    }
}

public enum APIKeyStore {
    private static let service = "com.geepus.assistant.api"
    private static let openAIAccount = "openai-api-key"

    public static func saveOpenAIKey(_ value: String) throws {
        var keychainError: Error?
        do {
            try KeychainStore.store(Data(value.utf8), service: service, account: openAIAccount)
        } catch {
            keychainError = error
        }

        do {
            try FallbackCredentialFileStore.saveOpenAIKey(value)
        } catch {
            if keychainError != nil {
                throw error
            }
        }

        if let keychainError {
            // Keychain can fail in unsigned/dev runs; fallback file is still saved.
            print("API key saved with fallback only: \(keychainError)")
        }
    }

    public static func loadOpenAIKey() throws -> String? {
        // Prefer fallback store to avoid repeated Keychain interaction prompts in dev builds.
        if let fallback = try FallbackCredentialFileStore.loadOpenAIKey(), !fallback.isEmpty {
            return fallback
        }

        guard let data = try KeychainStore.read(service: service, account: openAIAccount) else {
            return nil
        }
        let value = String(data: data, encoding: .utf8)
        if let value, !value.isEmpty {
            try? FallbackCredentialFileStore.saveOpenAIKey(value)
        }
        return value
    }

    public static func clearOpenAIKey() throws {
        KeychainStore.delete(service: service, account: openAIAccount)
        try? FallbackCredentialFileStore.clearOpenAIKey()
    }
}

private enum FallbackCredentialFileStore {
    private static let fileName = "openai_api_key.txt"

    static func saveOpenAIKey(_ value: String) throws {
        let path = try fileURL()
        try value.data(using: .utf8)?.write(to: path, options: .atomic)
        try setOwnerOnlyPermissions(path: path)
    }

    static func loadOpenAIKey() throws -> String? {
        let path = try fileURL()
        guard FileManager.default.fileExists(atPath: path.path) else { return nil }
        let data = try Data(contentsOf: path)
        return String(data: data, encoding: .utf8)
    }

    static func clearOpenAIKey() throws {
        let path = try fileURL()
        if FileManager.default.fileExists(atPath: path.path) {
            try FileManager.default.removeItem(at: path)
        }
    }

    private static func fileURL() throws -> URL {
        let base = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/GeepusAssistant/credentials", isDirectory: true)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent(fileName)
    }

    private static func setOwnerOnlyPermissions(path: URL) throws {
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
    }
}

enum SecretMaterialFileStore {
    static func read(id: String) throws -> Data? {
        let path = try fileURL(id: id)
        guard FileManager.default.fileExists(atPath: path.path) else { return nil }
        return try Data(contentsOf: path)
    }

    static func write(_ data: Data, id: String) throws {
        let path = try fileURL(id: id)
        try data.write(to: path, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
    }

    private static func fileURL(id: String) throws -> URL {
        let base = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/GeepusAssistant/secret-material", isDirectory: true)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("\(id).bin")
    }
}
