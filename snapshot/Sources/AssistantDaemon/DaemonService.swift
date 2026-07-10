import AssistantShared
import Foundation
import os

private struct LoopState: Sendable {
    var currentEngine: TaskEngine?
    var currentRunID: UUID?
}

/// Wraps a non-Sendable XPC reply closure so it can cross isolation boundaries.
/// Safe because XPC guarantees the reply is called exactly once.
private struct ReplyBox<T>: @unchecked Sendable {
    let reply: (T) -> Void
}

final class DaemonService: NSObject, AssistantDaemonXPCProtocol, @unchecked Sendable {
    private let baseDirectory: URL
    private let capabilityAuthority = CapabilityAuthority()
    private let loopState = OSAllocatedUnfairLock(initialState: LoopState())

    override init() {
        let appSupport = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/GeepusAssistant", isDirectory: true)
        self.baseDirectory = appSupport
        super.init()

        try? FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)
    }

    func run(_ request: AssistantRunRequest, withReply reply: @escaping (AssistantRunReply) -> Void) {
        let contractsData = request.contractsData
        let profileData = request.profileData
        let capabilityData = request.capabilityData
        let runtimeData = request.runtimeData
        let workspacePath = request.workspacePath
        let requestedRunID = request.runID
        let baseDir = self.baseDirectory
        let authority = self.capabilityAuthority

        // XPC reply closures are effectively serial; wrap to satisfy Sendable.
        let replyBox = ReplyBox(reply: reply)

        Task { [loopState] in
            do {
                let decoder = JSONDecoder()
                decoder.dateDecodingStrategy = .iso8601

                let contracts = try decoder.decode([ExecutionContract].self, from: contractsData)
                let profile = try decoder.decode(IdentityProfile.self, from: profileData)
                let capability = try decoder.decode(CapabilityToken.self, from: capabilityData)
                let runtime = try decoder.decode(RuntimeConfig.self, from: runtimeData)

                try authority.verify(capability)

                let runID = UUID(uuidString: requestedRunID) ?? UUID()
                let mirror = try WorkspaceMirror(
                    originalWorkspace: URL(fileURLWithPath: workspacePath),
                    mirrorBase: baseDir,
                    runID: runID
                )

                let ledger = try TaskLedger(baseDirectory: baseDir)
                let budgetManager = BudgetManager(rules: profile.policy.budgets)

                let engine = TaskEngine(
                    ledger: ledger,
                    budgetManager: budgetManager,
                    runtime: runtime
                )

                loopState.withLock {
                    $0.currentEngine = engine
                    $0.currentRunID = runID
                }

                let report = try await engine.run(
                    contracts: contracts,
                    profile: profile,
                    capability: capability,
                    mirror: mirror,
                    runID: runID
                )

                let reportData = try JSONEncoder().encode(report)
                replyBox.reply(AssistantRunReply(success: true, message: "Run completed", reportData: reportData))
            } catch {
                replyBox.reply(AssistantRunReply(success: false, message: "Run failed: \(error)", reportData: nil))
            }

            loopState.withLock {
                $0.currentEngine = nil
                $0.currentRunID = nil
            }
        }
    }

    func hardStop(withReply reply: @escaping (NSString) -> Void) {
        let (engine, runID) = loopState.withLock { ($0.currentEngine, $0.currentRunID) }
        engine?.hardStop()
        reply("Stop signal sent for run \(runID?.uuidString ?? "none")" as NSString)
    }

    func status(withReply reply: @escaping (NSString) -> Void) {
        let (running, runID) = loopState.withLock { ($0.currentEngine != nil, $0.currentRunID) }

        if running {
            reply("running:\(runID?.uuidString ?? "unknown")" as NSString)
        } else {
            reply("idle" as NSString)
        }
    }
}
