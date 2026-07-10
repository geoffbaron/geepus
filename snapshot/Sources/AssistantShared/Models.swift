import Foundation

public enum RiskLevel: String, Codable, Sendable {
    case low
    case medium
    case high
}

public enum PolicyOutcome: String, Codable, Sendable {
    case allow
    case requireApproval
    case deny
}

public enum ToolName: String, Codable, Sendable {
    case filesystemRead = "filesystem.read"
    case filesystemWrite = "filesystem.write"
    case shell = "shell.exec"
    case git = "git.exec"
    case webFetch = "web.fetch"
    case browserAction = "browser.action"
    case testRunner = "test.run"
    case linter = "lint.run"
}

public enum ProfileKind: String, Codable, CaseIterable, Sendable {
    case work
    case personal
}

public enum ModelBackend: String, Codable, CaseIterable, Sendable {
    case ollama
    case llamaCpp
    case mlx
    case api
}

public enum ModelMode: String, Codable, CaseIterable, Sendable {
    case draft
    case heavyReasoning
    case offline
}

public struct DomainRule: Codable, Sendable, Hashable {
    public let host: String

    public init(host: String) {
        self.host = host.lowercased()
    }
}

public struct BudgetRules: Codable, Sendable {
    public var maxTokensPerSession: Int
    public var maxCommandsPerSession: Int
    public var maxFileWrites: Int
    public var maxNetworkCalls: Int
    public var maxRuntimeSeconds: Int

    public static let conservativeDefaults = BudgetRules(
        maxTokensPerSession: 50_000,
        maxCommandsPerSession: 100,
        maxFileWrites: 100,
        maxNetworkCalls: 20,
        maxRuntimeSeconds: 14_400
    )
}

public struct ProfilePolicy: Codable, Sendable {
    public var readRoots: [String]
    public var writeRoots: [String]
    public var workspaceRoot: String
    public var shellAllowlist: [String]
    public var domainAllowlist: [DomainRule]
    public var allowExternalAppAutomation: [String]
    public var budgets: BudgetRules

    public init(
        readRoots: [String],
        writeRoots: [String],
        workspaceRoot: String,
        shellAllowlist: [String],
        domainAllowlist: [DomainRule],
        allowExternalAppAutomation: [String],
        budgets: BudgetRules = .conservativeDefaults
    ) {
        self.readRoots = readRoots
        self.writeRoots = writeRoots
        self.workspaceRoot = workspaceRoot
        self.shellAllowlist = shellAllowlist
        self.domainAllowlist = domainAllowlist
        self.allowExternalAppAutomation = allowExternalAppAutomation
        self.budgets = budgets
    }
}

public struct IdentityProfile: Codable, Sendable {
    public var id: UUID
    public var name: String
    public var kind: ProfileKind
    public var policy: ProfilePolicy

    public init(id: UUID = UUID(), name: String, kind: ProfileKind, policy: ProfilePolicy) {
        self.id = id
        self.name = name
        self.kind = kind
        self.policy = policy
    }
}

public struct ModelSelection: Codable, Sendable {
    public var mode: ModelMode
    public var backend: ModelBackend
    public var modelIdentifier: String

    public init(mode: ModelMode, backend: ModelBackend, modelIdentifier: String) {
        self.mode = mode
        self.backend = backend
        self.modelIdentifier = modelIdentifier
    }
}

public struct TokenStats: Codable, Sendable {
    public var promptTokens: Int
    public var completionTokens: Int

    public init(promptTokens: Int = 0, completionTokens: Int = 0) {
        self.promptTokens = promptTokens
        self.completionTokens = completionTokens
    }
}

public struct SessionUsage: Codable, Sendable {
    public var commandsExecuted: Int
    public var filesWritten: Int
    public var networkCalls: Int
    public var tokenStats: TokenStats
    public var startedAt: Date

    public init(
        commandsExecuted: Int = 0,
        filesWritten: Int = 0,
        networkCalls: Int = 0,
        tokenStats: TokenStats = TokenStats(),
        startedAt: Date = Date()
    ) {
        self.commandsExecuted = commandsExecuted
        self.filesWritten = filesWritten
        self.networkCalls = networkCalls
        self.tokenStats = tokenStats
        self.startedAt = startedAt
    }
}

public struct ExecutionResult: Codable, Sendable {
    public var success: Bool
    public var summary: String
    public var output: String
    public var timestamp: Date

    public init(success: Bool, summary: String, output: String = "", timestamp: Date = Date()) {
        self.success = success
        self.summary = summary
        self.output = output
        self.timestamp = timestamp
    }
}

public struct PlanStep: Codable, Sendable, Identifiable {
    public var id: UUID
    public var title: String
    public var detail: String
    public var requiresApproval: Bool

    public init(id: UUID = UUID(), title: String, detail: String, requiresApproval: Bool = false) {
        self.id = id
        self.title = title
        self.detail = detail
        self.requiresApproval = requiresApproval
    }
}

public struct AssistantPlan: Codable, Sendable {
    public var runID: UUID
    public var createdAt: Date
    public var steps: [PlanStep]

    public init(runID: UUID = UUID(), createdAt: Date = Date(), steps: [PlanStep]) {
        self.runID = runID
        self.createdAt = createdAt
        self.steps = steps
    }
}

public struct RuntimeConfig: Codable, Sendable {
    public var checkpointEveryActions: Int
    public var checkpointEveryMinutes: Int
    public var offlineMode: Bool

    public init(checkpointEveryActions: Int = 5, checkpointEveryMinutes: Int = 5, offlineMode: Bool = true) {
        self.checkpointEveryActions = checkpointEveryActions
        self.checkpointEveryMinutes = checkpointEveryMinutes
        self.offlineMode = offlineMode
    }
}
