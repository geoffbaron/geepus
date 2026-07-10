import Foundation

public enum JSONValue: Codable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
            return
        }
        if let value = try? container.decode(Bool.self) {
            self = .bool(value)
            return
        }
        if let value = try? container.decode(Double.self) {
            self = .number(value)
            return
        }
        if let value = try? container.decode(String.self) {
            self = .string(value)
            return
        }
        if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
            return
        }
        if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
            return
        }
        throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    public var stringValue: String? {
        guard case .string(let value) = self else { return nil }
        return value
    }

    public var objectValue: [String: JSONValue]? {
        guard case .object(let value) = self else { return nil }
        return value
    }

    public var arrayValue: [JSONValue]? {
        guard case .array(let value) = self else { return nil }
        return value
    }

    public var boolValue: Bool? {
        guard case .bool(let value) = self else { return nil }
        return value
    }
}

public struct ExecutionContract: Codable, Sendable {
    public var id: UUID
    public var intent: String
    public var tool: ToolName
    public var exactArgs: [String: JSONValue]
    public var expectedDiff: String
    public var rollbackPlan: String
    public var riskLevel: RiskLevel

    public init(
        id: UUID = UUID(),
        intent: String,
        tool: ToolName,
        exactArgs: [String: JSONValue],
        expectedDiff: String,
        rollbackPlan: String,
        riskLevel: RiskLevel
    ) {
        self.id = id
        self.intent = intent
        self.tool = tool
        self.exactArgs = exactArgs
        self.expectedDiff = expectedDiff
        self.rollbackPlan = rollbackPlan
        self.riskLevel = riskLevel
    }
}

public enum ContractValidationError: Error, CustomStringConvertible {
    case missingIntent
    case missingTool
    case emptyArgs
    case missingExpectedDiff
    case missingRollback
    case highRiskWithoutRollback

    public var description: String {
        switch self {
        case .missingIntent: return "intent is required"
        case .missingTool: return "tool is required"
        case .emptyArgs: return "exact_args cannot be empty"
        case .missingExpectedDiff: return "expected_diff is required"
        case .missingRollback: return "rollback_plan is required"
        case .highRiskWithoutRollback: return "high-risk actions require a concrete rollback plan"
        }
    }
}

public struct ExecutionContractValidator {
    public init() {}

    public func validate(_ contract: ExecutionContract) throws {
        if contract.intent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw ContractValidationError.missingIntent
        }

        if contract.expectedDiff.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw ContractValidationError.missingExpectedDiff
        }

        if contract.exactArgs.isEmpty {
            throw ContractValidationError.emptyArgs
        }

        if contract.rollbackPlan.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw ContractValidationError.missingRollback
        }

        if contract.riskLevel == .high && contract.rollbackPlan.count < 12 {
            throw ContractValidationError.highRiskWithoutRollback
        }
    }
}
