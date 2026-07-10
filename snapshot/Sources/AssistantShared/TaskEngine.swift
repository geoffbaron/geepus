import Foundation
import os

public struct RunCheckpoint: Codable, Sendable {
    public let id: UUID
    public let runID: UUID
    public let actionIndex: Int
    public let createdAt: Date
    public let snapshot: MirrorSnapshot

    public init(id: UUID = UUID(), runID: UUID, actionIndex: Int, createdAt: Date = Date(), snapshot: MirrorSnapshot) {
        self.id = id
        self.runID = runID
        self.actionIndex = actionIndex
        self.createdAt = createdAt
        self.snapshot = snapshot
    }
}

public struct RunState: Codable, Sendable {
    public let runID: UUID
    public var nextActionIndex: Int
    public var checkpoints: [RunCheckpoint]
    public var isHalted: Bool

    public init(runID: UUID, nextActionIndex: Int = 0, checkpoints: [RunCheckpoint] = [], isHalted: Bool = false) {
        self.runID = runID
        self.nextActionIndex = nextActionIndex
        self.checkpoints = checkpoints
        self.isHalted = isHalted
    }
}

public struct LoopReport: Codable, Sendable {
    public let runID: UUID
    public let results: [ExecutionResult]
    public let halted: Bool

    public init(runID: UUID, results: [ExecutionResult], halted: Bool) {
        self.runID = runID
        self.results = results
        self.halted = halted
    }
}

public struct AuditEntry: Codable, Sendable {
    public let id: UUID
    public let timestamp: Date
    public let runID: UUID
    public let stage: String
    public let contract: ExecutionContract?
    public let decision: PolicyDecision?
    public let result: ExecutionResult?
    public let explanation: String
    public let previousHash: String
    public let hash: String

    public init(id: UUID = UUID(), timestamp: Date = Date(), runID: UUID, stage: String, contract: ExecutionContract?, decision: PolicyDecision?, result: ExecutionResult?, explanation: String, previousHash: String, hash: String) {
        self.id = id
        self.timestamp = timestamp
        self.runID = runID
        self.stage = stage
        self.contract = contract
        self.decision = decision
        self.result = result
        self.explanation = explanation
        self.previousHash = previousHash
        self.hash = hash
    }
}

public enum EnginePhase: String, Codable, Sendable {
    case planner
    case executor
    case supervisor
    case completed
    case halted
}

public struct TaskEngineState: Codable, Sendable {
    public let runID: UUID
    public var phase: EnginePhase
    public var nextActionIndex: Int
    public var contracts: [ExecutionContract]
    public var results: [ExecutionResult]
    public var checkpoints: [RunCheckpoint]

    public init(runID: UUID, phase: EnginePhase = .planner, nextActionIndex: Int = 0, contracts: [ExecutionContract] = [], results: [ExecutionResult] = [], checkpoints: [RunCheckpoint] = []) {
        self.runID = runID
        self.phase = phase
        self.nextActionIndex = nextActionIndex
        self.contracts = contracts
        self.results = results
        self.checkpoints = checkpoints
    }
}

public final class TaskEngine: @unchecked Sendable {
    private let validator = ExecutionContractValidator()
    private let policy = PolicyEngine()
    private let tools = ToolExecutor()
    private let ledger: TaskLedger
    private let budgetManager: BudgetManager
    private let runtime: RuntimeConfig

    private let _halted = OSAllocatedUnfairLock(initialState: false)

    public var halted: Bool {
        get { _halted.withLock { $0 } }
        set { _halted.withLock { $0 = newValue } }
    }

    public init(
        ledger: TaskLedger,
        budgetManager: BudgetManager,
        runtime: RuntimeConfig
    ) {
        self.ledger = ledger
        self.budgetManager = budgetManager
        self.runtime = runtime
    }

    public func hardStop() {
        halted = true
        tools.terminateAll()
    }

    private func step(
        state: inout TaskEngineState,
        profile: IdentityProfile,
        capability: CapabilityToken,
        mirror: WorkspaceMirror
    ) async throws -> Bool { // returns true if should continue
        if halted {
            state.phase = .halted
            try await ledger.appendEvent(runID: state.runID, stage: "engine", explanation: "Engine halted by user")
            try await ledger.saveState(convertToRunState(state, isHalted: true))
            return false
        }

        switch state.phase {
        case .planner:
            try await ledger.appendEvent(runID: state.runID, stage: "planner", explanation: "Planner phase started. Evaluating \(state.contracts.count) contracts.")
            for contract in state.contracts {
                try validator.validate(contract)
            }
            state.phase = .executor
            try await ledger.saveState(convertToRunState(state, isHalted: false))
            return true

        case .executor:
            if state.nextActionIndex >= state.contracts.count {
                state.phase = .supervisor
                try await ledger.appendEvent(runID: state.runID, stage: "executor", explanation: "All actions executed. Transitioning to supervisor.")
                try await ledger.saveState(convertToRunState(state, isHalted: false))
                return true
            }

            let index = state.nextActionIndex
            let contract = state.contracts[index]
            try await budgetManager.checkBudgets()

            let context = PolicyContext(profile: profile, capability: capability, runtime: runtime)
            let decision = policy.evaluate(contract: contract, context: context)

            try await ledger.appendEvent(
                runID: state.runID,
                stage: "policy",
                contract: contract,
                decision: decision,
                explanation: "Policy checked for action \(index)"
            )

            if decision.outcome == .requireApproval {
                let blocked = ExecutionResult(success: false, summary: "Approval required", output: decision.reasons.joined(separator: " | "))
                state.results.append(blocked)
                // Skip the blocked step if rejected or simply require approval? 
                // Currently just failing the step and moving to next, recording approval in ledger.
                _ = try await ledger.addApprovalRequest(runID: state.runID, requestData: blocked.output)
                
                state.nextActionIndex += 1
                try await ledger.saveState(convertToRunState(state, isHalted: false))
                return true
            }
            
            if decision.outcome == .deny {
                let denied = ExecutionResult(success: false, summary: "Denied by policy", output: decision.reasons.joined(separator: " | "))
                state.results.append(denied)
                state.nextActionIndex += 1
                try await ledger.saveState(convertToRunState(state, isHalted: false))
                return true
            }

            let executionContext = ToolExecutionContext(profile: profile, runtime: runtime, mirror: mirror, capability: capability)
            let result = tools.execute(contract, context: executionContext)
            
            try await budgetManager.recordToolUse(tool: contract.tool)
            state.results.append(result)

            try await ledger.appendEvent(
                runID: state.runID,
                stage: "execute",
                contract: contract,
                decision: decision,
                result: result,
                explanation: "Executed step \(index) exactly once"
            )

            state.nextActionIndex += 1

            let shouldCheckpoint = state.nextActionIndex % runtime.checkpointEveryActions == 0
            if shouldCheckpoint {
                let checkpoint = RunCheckpoint(runID: state.runID, actionIndex: state.nextActionIndex, snapshot: mirror.snapshot())
                state.checkpoints.append(checkpoint)
                try await ledger.appendEvent(runID: state.runID, stage: "checkpoint", explanation: "Checkpoint created")
            }

            try await ledger.saveState(convertToRunState(state, isHalted: false))
            return true

        case .supervisor:
            try await ledger.appendEvent(runID: state.runID, stage: "supervisor", explanation: "Supervisor evaluating execution outcomes.")
            
            let testResult = tools.execute(
                ExecutionContract(intent: "Validate workspace", tool: .testRunner, exactArgs: ["scope": .string("workspace")], expectedDiff: "none", rollbackPlan: "none", riskLevel: .low),
                context: ToolExecutionContext(profile: profile, runtime: runtime, mirror: mirror, capability: capability)
            )

            let lintResult = tools.execute(
                ExecutionContract(intent: "Lint workspace", tool: .linter, exactArgs: ["scope": .string("workspace")], expectedDiff: "none", rollbackPlan: "none", riskLevel: .low),
                context: ToolExecutionContext(profile: profile, runtime: runtime, mirror: mirror, capability: capability)
            )

            try await ledger.appendEvent(runID: state.runID, stage: "validate", result: testResult, explanation: "Supervisor post-run tests")
            try await ledger.appendEvent(runID: state.runID, stage: "validate", result: lintResult, explanation: "Supervisor post-run lint")

            if testResult.success && lintResult.success {
                try mirror.writeBackIfChecksPass(testResult: testResult, lintResult: lintResult)
                try await ledger.appendEvent(runID: state.runID, stage: "write-back", explanation: "Mirror written back to workspace")
            } else {
                try await ledger.appendEvent(runID: state.runID, stage: "write-back", explanation: "Write-back skipped due to validation failure")
            }

            state.phase = .completed
            try await ledger.saveState(convertToRunState(state, isHalted: false))
            return false

        case .completed, .halted:
            return false
        }
    }

    public func run(
        contracts: [ExecutionContract],
        profile: IdentityProfile,
        capability: CapabilityToken,
        mirror: WorkspaceMirror,
        runID: UUID
    ) async throws -> LoopReport {
        try mirror.initializeMirror()

        var state: TaskEngineState
        if let runState = try await ledger.loadState(runID: runID) {
            state = TaskEngineState(
                runID: runID,
                phase: runState.nextActionIndex >= contracts.count ? .supervisor : .executor,
                nextActionIndex: runState.nextActionIndex,
                contracts: contracts,
                results: [],
                checkpoints: runState.checkpoints
            )
        } else {
            state = TaskEngineState(runID: runID, phase: .planner, nextActionIndex: 0, contracts: contracts)
        }

        var running = true
        while running {
            running = try await step(state: &state, profile: profile, capability: capability, mirror: mirror)
        }

        return LoopReport(runID: runID, results: state.results, halted: halted)
    }

    private func convertToRunState(_ state: TaskEngineState, isHalted: Bool) -> RunState {
        return RunState(
            runID: state.runID,
            nextActionIndex: state.nextActionIndex,
            checkpoints: state.checkpoints,
            isHalted: isHalted
        )
    }
}
