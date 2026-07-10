import Foundation

public struct PolicyDecision: Codable, Sendable {
    public let outcome: PolicyOutcome
    public let reasons: [String]
    public let computedRisk: RiskLevel

    public init(outcome: PolicyOutcome, reasons: [String], computedRisk: RiskLevel) {
        self.outcome = outcome
        self.reasons = reasons
        self.computedRisk = computedRisk
    }
}

public struct PolicyContext: Sendable {
    public let profile: IdentityProfile
    public let capability: CapabilityToken
    public let runtime: RuntimeConfig

    public init(profile: IdentityProfile, capability: CapabilityToken, runtime: RuntimeConfig) {
        self.profile = profile
        self.capability = capability
        self.runtime = runtime
    }
}

public final class PolicyEngine: Sendable {
    public init() {}

    public func evaluate(contract: ExecutionContract, context: PolicyContext) -> PolicyDecision {
        var reasons: [String] = []
        var riskScore = baseRiskScore(for: contract.riskLevel)

        if isHardDenied(contract: contract) {
            reasons.append("Action matches hard deny policy.")
            return PolicyDecision(outcome: .deny, reasons: reasons, computedRisk: .high)
        }

        if !isCapabilityAllowed(contract: contract, capability: context.capability) {
            reasons.append("Capability token does not allow this operation.")
            return PolicyDecision(outcome: .deny, reasons: reasons, computedRisk: .high)
        }

        switch contract.tool {
        case .filesystemRead:
            riskScore += 1
        case .filesystemWrite:
            riskScore += 2
            if modifiesProjectConfiguration(contract) {
                reasons.append("Project configuration change requires explicit approval.")
                return PolicyDecision(outcome: .requireApproval, reasons: reasons, computedRisk: .high)
            }
        case .shell:
            riskScore += 3
            if !isAllowlistedShell(contract: contract, profile: context.profile) {
                reasons.append("Non-allowlisted command requires explicit approval.")
                return PolicyDecision(outcome: .requireApproval, reasons: reasons, computedRisk: .high)
            }
            if isInstallCommand(contract) {
                reasons.append("Package installs require explicit approval.")
                return PolicyDecision(outcome: .requireApproval, reasons: reasons, computedRisk: .high)
            }
        case .git:
            riskScore += 2
            if isGitPush(contract) {
                reasons.append("git push requires explicit approval.")
                return PolicyDecision(outcome: .requireApproval, reasons: reasons, computedRisk: .high)
            }
        case .webFetch:
            riskScore += 3
            if context.runtime.offlineMode {
                reasons.append("Offline mode is enabled.")
                return PolicyDecision(outcome: .deny, reasons: reasons, computedRisk: .high)
            }
            reasons.append("Network requests require explicit approval.")
            return PolicyDecision(outcome: .requireApproval, reasons: reasons, computedRisk: .medium)
        case .browserAction:
            riskScore += 3
        case .testRunner, .linter:
            riskScore += 1
        }

        let computedRisk = riskFromScore(riskScore)
        reasons.append("Policy checks passed.")
        return PolicyDecision(outcome: .allow, reasons: reasons, computedRisk: computedRisk)
    }

    private func baseRiskScore(for level: RiskLevel) -> Int {
        switch level {
        case .low: return 1
        case .medium: return 4
        case .high: return 7
        }
    }

    private func riskFromScore(_ score: Int) -> RiskLevel {
        switch score {
        case ..<4: return .low
        case 4..<8: return .medium
        default: return .high
        }
    }

    private func isHardDenied(contract: ExecutionContract) -> Bool {
        let flattenedArgs = flattenArgs(contract.exactArgs).lowercased()

        let deniedPatterns = [
            "keychain",
            ".ssh",
            "launchagents",
            "launchdaemons",
            "sudo",
            "codesign",
            "/system/",
            "security find-generic-password",
            "curl -d",
            "scp ",
            "rsync ",
            "aws_secret_access_key",
            "openai_api_key"
        ]

        if deniedPatterns.contains(where: { flattenedArgs.contains($0) }) {
            return true
        }

        if flattenedArgs.contains("rm -rf") && !flattenedArgs.contains("workspace_mirror") {
            return true
        }

        return false
    }

    private func isCapabilityAllowed(contract: ExecutionContract, capability: CapabilityToken) -> Bool {
        switch contract.tool {
        case .filesystemRead:
            return hasFilePermission(contract: contract, scopes: capability.claims.fileScopes, requireWrite: false)
        case .filesystemWrite:
            return hasFilePermission(contract: contract, scopes: capability.claims.fileScopes, requireWrite: true)
        case .shell:
            return capability.claims.shellScope != nil
        case .webFetch:
            return capability.claims.networkScope != nil
        case .browserAction:
            return capability.claims.shellScope != nil
        case .git:
            return capability.claims.gitScope != nil
        case .testRunner, .linter:
            return capability.claims.shellScope != nil
        }
    }

    private func hasFilePermission(contract: ExecutionContract, scopes: [FileScope], requireWrite: Bool) -> Bool {
        guard let path = contract.exactArgs["path"]?.stringValue ?? contract.exactArgs["relativePath"]?.stringValue else {
            return false
        }

        for scope in scopes {
            let allowsWrite = scope.access == .write
            if path.hasPrefix(scope.root) || !path.hasPrefix("/") {
                if requireWrite {
                    if allowsWrite { return true }
                } else {
                    return true
                }
            }
        }
        return false
    }

    private func isAllowlistedShell(contract: ExecutionContract, profile: IdentityProfile) -> Bool {
        guard let command = contract.exactArgs["command"]?.stringValue else {
            return false
        }

        guard let executable = command.split(separator: " ").first.map(String.init) else {
            return false
        }

        return profile.policy.shellAllowlist.contains(executable)
    }

    private func isInstallCommand(_ contract: ExecutionContract) -> Bool {
        guard let command = contract.exactArgs["command"]?.stringValue?.lowercased() else {
            return false
        }

        return command.contains("npm install") || command.contains("pip install") || command.contains("brew install")
    }

    private func isGitPush(_ contract: ExecutionContract) -> Bool {
        guard let command = contract.exactArgs["command"]?.stringValue?.lowercased() else {
            return false
        }
        return command.contains("push")
    }

    private func modifiesProjectConfiguration(_ contract: ExecutionContract) -> Bool {
        let targets = ["package.json", "pyproject.toml", "podfile", "package.swift", "xcodeproj", "xcworkspace"]
        guard let path = contract.exactArgs["path"]?.stringValue ?? contract.exactArgs["relativePath"]?.stringValue else {
            return false
        }
        return targets.contains(where: { path.lowercased().contains($0) })
    }

    private func flattenArgs(_ args: [String: JSONValue]) -> String {
        args.map { key, value in
            "\(key)=\(stringify(value))"
        }
        .joined(separator: " ")
    }

    private func stringify(_ value: JSONValue) -> String {
        switch value {
        case .string(let s): return s
        case .number(let n): return "\(n)"
        case .bool(let b): return "\(b)"
        case .object(let o): return o.map { "\($0.key):\(stringify($0.value))" }.joined(separator: ",")
        case .array(let a): return a.map(stringify).joined(separator: ",")
        case .null: return "null"
        }
    }
}
