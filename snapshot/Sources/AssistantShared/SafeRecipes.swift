import Foundation

public enum SafeRecipe: String, CaseIterable, Codable, Sendable {
    case codeChange
    case research
    case refactor
    case documentation
}

public struct RecipeBuilder {
    public init() {}

    public func build(recipe: SafeRecipe, task: String) -> [ExecutionContract] {
        switch recipe {
        case .codeChange:
            return [
                ExecutionContract(
                    intent: "Read target file",
                    tool: .filesystemRead,
                    exactArgs: ["relativePath": .string("README.md")],
                    expectedDiff: "No diff",
                    rollbackPlan: "No rollback needed",
                    riskLevel: .low
                ),
                ExecutionContract(
                    intent: "Write code updates in mirror",
                    tool: .filesystemWrite,
                    exactArgs: [
                        "relativePath": .string("README.md"),
                        "content": .string("# Update\n\n\(task)\n")
                    ],
                    expectedDiff: "README updated",
                    rollbackPlan: "Discard mirror snapshot",
                    riskLevel: .medium
                )
            ]

        case .research:
            return [
                ExecutionContract(
                    intent: "Collect local project context",
                    tool: .filesystemRead,
                    exactArgs: ["relativePath": .string("README.md")],
                    expectedDiff: "No file changes",
                    rollbackPlan: "No rollback needed",
                    riskLevel: .low
                )
            ]

        case .refactor:
            return [
                ExecutionContract(
                    intent: "Run tests before refactor",
                    tool: .testRunner,
                    exactArgs: ["scope": .string("workspace")],
                    expectedDiff: "No file changes",
                    rollbackPlan: "No rollback needed",
                    riskLevel: .low
                )
            ]

        case .documentation:
            return [
                ExecutionContract(
                    intent: "Write documentation draft",
                    tool: .filesystemWrite,
                    exactArgs: [
                        "relativePath": .string("docs/assistant-report.md"),
                        "content": .string("# Assistant Report\n\nTask: \(task)\n")
                    ],
                    expectedDiff: "Add assistant report",
                    rollbackPlan: "Delete generated doc from mirror",
                    riskLevel: .low
                )
            ]
        }
    }
}
