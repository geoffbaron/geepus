import CryptoKit
import Foundation

public struct FileScope: Codable, Sendable {
    public enum Access: String, Codable, Sendable {
        case readOnly
        case write
    }

    public let root: String
    public let access: Access

    public init(root: String, access: Access) {
        self.root = root
        self.access = access
    }
}

public struct ShellScope: Codable, Sendable {
    public let allowlistedCommands: [String]

    public init(allowlistedCommands: [String]) {
        self.allowlistedCommands = allowlistedCommands
    }
}

public struct NetworkScope: Codable, Sendable {
    public let domains: [String]

    public init(domains: [String]) {
        self.domains = domains.map { $0.lowercased() }
    }
}

public struct GitScope: Codable, Sendable {
    public let allowPush: Bool
    public let allowBranchCreate: Bool

    public init(allowPush: Bool = false, allowBranchCreate: Bool = true) {
        self.allowPush = allowPush
        self.allowBranchCreate = allowBranchCreate
    }
}

public struct AutomationScope: Codable, Sendable {
    public let allowedBundleIDs: [String]

    public init(allowedBundleIDs: [String]) {
        self.allowedBundleIDs = allowedBundleIDs
    }
}

public struct CapabilityClaims: Codable, Sendable {
    public let profileID: UUID
    public let expiresAt: Date
    public let fileScopes: [FileScope]
    public let shellScope: ShellScope?
    public let networkScope: NetworkScope?
    public let gitScope: GitScope?
    public let automationScope: AutomationScope?

    public init(
        profileID: UUID,
        expiresAt: Date,
        fileScopes: [FileScope],
        shellScope: ShellScope? = nil,
        networkScope: NetworkScope? = nil,
        gitScope: GitScope? = nil,
        automationScope: AutomationScope? = nil
    ) {
        self.profileID = profileID
        self.expiresAt = expiresAt
        self.fileScopes = fileScopes
        self.shellScope = shellScope
        self.networkScope = networkScope
        self.gitScope = gitScope
        self.automationScope = automationScope
    }
}

public struct CapabilityToken: Codable, Sendable {
    public let id: UUID
    public let issuedAt: Date
    public let claims: CapabilityClaims
    public let signature: String

    public init(id: UUID = UUID(), issuedAt: Date = Date(), claims: CapabilityClaims, signature: String) {
        self.id = id
        self.issuedAt = issuedAt
        self.claims = claims
        self.signature = signature
    }
}

public enum CapabilityError: Error, CustomStringConvertible {
    case keyUnavailable
    case signatureInvalid
    case tokenExpired

    public var description: String {
        switch self {
        case .keyUnavailable: return "capability signing key unavailable"
        case .signatureInvalid: return "capability signature invalid"
        case .tokenExpired: return "capability token expired"
        }
    }
}

public final class CapabilityAuthority: Sendable {
    private let service = "com.geepus.assistant.capability"
    private let account = "signing-key"
    private let localKeyID = "capability-signing-key"

    public init() {}

    public func issueToken(claims: CapabilityClaims) throws -> CapabilityToken {
        let keyData = try signingKeyData()
        let payload = SignedPayload(id: UUID(), issuedAt: Date(), claims: claims)
        let payloadData = try JSONEncoder().encode(payload)
        let signature = HMAC<SHA256>.authenticationCode(for: payloadData, using: SymmetricKey(data: keyData))

        return CapabilityToken(
            id: payload.id,
            issuedAt: payload.issuedAt,
            claims: claims,
            signature: Data(signature).base64EncodedString()
        )
    }

    public func verify(_ token: CapabilityToken, now: Date = Date()) throws {
        guard token.claims.expiresAt > now else {
            throw CapabilityError.tokenExpired
        }

        let keyData = try signingKeyData()
        let payload = SignedPayload(id: token.id, issuedAt: token.issuedAt, claims: token.claims)
        let payloadData = try JSONEncoder().encode(payload)
        let expectedSignature = HMAC<SHA256>.authenticationCode(for: payloadData, using: SymmetricKey(data: keyData))

        guard let signatureData = Data(base64Encoded: token.signature),
              Data(expectedSignature) == signatureData else {
            throw CapabilityError.signatureInvalid
        }
    }

    private func signingKeyData() throws -> Data {
        if let local = try SecretMaterialFileStore.read(id: localKeyID) {
            return local
        }

        if let keychainData = try? KeychainStore.read(service: service, account: account) {
            try? SecretMaterialFileStore.write(keychainData, id: localKeyID)
            return keychainData
        }

        let key = SymmetricKey(size: .bits256)
        let keyData = key.withUnsafeBytes { Data($0) }
        try SecretMaterialFileStore.write(keyData, id: localKeyID)
        try? KeychainStore.store(keyData, service: service, account: account)
        return keyData
    }

    private struct SignedPayload: Codable {
        let id: UUID
        let issuedAt: Date
        let claims: CapabilityClaims
    }
}
