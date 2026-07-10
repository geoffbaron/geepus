import Foundation

public enum BudgetViolation: Error, CustomStringConvertible {
    case tokenLimit
    case commandLimit
    case fileWriteLimit
    case networkLimit
    case runtimeLimit

    public var description: String {
        switch self {
        case .tokenLimit: return "token budget exceeded"
        case .commandLimit: return "command budget exceeded"
        case .fileWriteLimit: return "file write budget exceeded"
        case .networkLimit: return "network call budget exceeded"
        case .runtimeLimit: return "runtime budget exceeded"
        }
    }
}

public actor BudgetManager {
    private let rules: BudgetRules
    private(set) public var usage: SessionUsage

    public init(rules: BudgetRules, usage: SessionUsage = SessionUsage()) {
        self.rules = rules
        self.usage = usage
    }

    public func recordToolUse(tool: ToolName) throws {
        usage.commandsExecuted += 1

        switch tool {
        case .filesystemWrite:
            usage.filesWritten += 1
        case .webFetch:
            usage.networkCalls += 1
        default:
            break
        }

        try checkBudgets()
    }

    public func recordTokens(prompt: Int, completion: Int) throws {
        usage.tokenStats.promptTokens += prompt
        usage.tokenStats.completionTokens += completion
        try checkBudgets()
    }

    public func checkBudgets(now: Date = Date()) throws {
        if usage.tokenStats.promptTokens + usage.tokenStats.completionTokens > rules.maxTokensPerSession {
            throw BudgetViolation.tokenLimit
        }

        if usage.commandsExecuted > rules.maxCommandsPerSession {
            throw BudgetViolation.commandLimit
        }

        if usage.filesWritten > rules.maxFileWrites {
            throw BudgetViolation.fileWriteLimit
        }

        if usage.networkCalls > rules.maxNetworkCalls {
            throw BudgetViolation.networkLimit
        }

        if now.timeIntervalSince(usage.startedAt) > Double(rules.maxRuntimeSeconds) {
            throw BudgetViolation.runtimeLimit
        }
    }
}
