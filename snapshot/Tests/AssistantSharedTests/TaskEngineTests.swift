import XCTest
@testable import AssistantShared

final class TaskEngineTests: XCTestCase {
    func testStateMachineTransitions() async throws {
        let tempDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let ledger = try TaskLedger(baseDirectory: tempDir)
        let budgetManager = BudgetManager(rules: .conservativeDefaults)
        let engine = TaskEngine(ledger: ledger, budgetManager: budgetManager, runtime: RuntimeConfig())
        
        let contract = ExecutionContract(
            intent: "Read a file",
            tool: .filesystemRead,
            exactArgs: ["relativePath": .string("README.md")],
            expectedDiff: "none",
            rollbackPlan: "none",
            riskLevel: .low
        )
        
        let profile = IdentityProfile(
            name: "Test",
            kind: .personal,
            policy: ProfilePolicy(
                readRoots: ["/"],
                writeRoots: ["/"],
                workspaceRoot: "/",
                shellAllowlist: ["swift", "test", "lint"],
                domainAllowlist: [],
                allowExternalAppAutomation: []
            )
        )
        let capability = CapabilityToken(claims: CapabilityClaims(profileID: profile.id, expiresAt: Date().addingTimeInterval(3600), fileScopes: [FileScope(root: "/", access: .write)], shellScope: ShellScope(allowlistedCommands: ["swift"])), signature: "stub")
        let mockWorkspace = tempDir.appendingPathComponent("mock_workspace")
        try FileManager.default.createDirectory(at: mockWorkspace, withIntermediateDirectories: true)
        try "dummy".write(to: mockWorkspace.appendingPathComponent("README.md"), atomically: true, encoding: .utf8)
        
        let mirror = try WorkspaceMirror(originalWorkspace: mockWorkspace, mirrorBase: tempDir, runID: UUID())
        
        let report = try await engine.run(
            contracts: [contract],
            profile: profile,
            capability: capability,
            mirror: mirror,
            runID: UUID()
        )
        
        XCTAssertEqual(report.results.count, 1) // One tool executed exactly once
        XCTAssertFalse(report.halted)
    }
}
