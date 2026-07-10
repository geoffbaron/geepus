import XCTest
@testable import AssistantShared

final class AssistantSharedTests: XCTestCase {
    func testExecutionContractValidation() throws {
        let contract = ExecutionContract(
            intent: "Write a file",
            tool: .filesystemWrite,
            exactArgs: ["relativePath": .string("README.md"), "content": .string("ok")],
            expectedDiff: "README updated",
            rollbackPlan: "revert mirror snapshot",
            riskLevel: .medium
        )

        XCTAssertNoThrow(try ExecutionContractValidator().validate(contract))
    }

    func testPolicyDeniesHardPatterns() {
        let profile = IdentityProfile(
            name: "Work",
            kind: .work,
            policy: ProfilePolicy(
                readRoots: ["/tmp/work"],
                writeRoots: ["/tmp/work"],
                workspaceRoot: "/tmp/work",
                shellAllowlist: ["git"],
                domainAllowlist: [],
                allowExternalAppAutomation: []
            )
        )

        let token = CapabilityToken(
            claims: CapabilityClaims(
                profileID: profile.id,
                expiresAt: Date().addingTimeInterval(60),
                fileScopes: [FileScope(root: "/tmp/work", access: .write)],
                shellScope: ShellScope(allowlistedCommands: ["git"])
            ),
            signature: "stub"
        )

        let contract = ExecutionContract(
            intent: "Bad",
            tool: .shell,
            exactArgs: ["command": .string("sudo rm -rf /System")],
            expectedDiff: "none",
            rollbackPlan: "none",
            riskLevel: .high
        )

        let decision = PolicyEngine().evaluate(
            contract: contract,
            context: PolicyContext(profile: profile, capability: token, runtime: RuntimeConfig())
        )

        XCTAssertEqual(decision.outcome, .deny)
    }

    func testBudgetLimits() async {
        let manager = BudgetManager(
            rules: BudgetRules(
                maxTokensPerSession: 10,
                maxCommandsPerSession: 1,
                maxFileWrites: 1,
                maxNetworkCalls: 1,
                maxRuntimeSeconds: 100
            )
        )

        do {
            try await manager.recordToolUse(tool: .filesystemRead)
        } catch {
            XCTFail("First recordToolUse should not throw: \(error)")
        }

        do {
            try await manager.recordToolUse(tool: .filesystemRead)
            XCTFail("Second recordToolUse should have thrown")
        } catch {
            // Expected
        }
    }
}
