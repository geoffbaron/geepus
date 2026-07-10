import Foundation

public final class SubprocessManager: @unchecked Sendable {
    private var processes: [Process] = []
    private let lock = NSLock()

    public init() {}

    public func run(
        command: String,
        arguments: [String],
        currentDirectory: URL? = nil,
        environment: [String: String] = [:],
        timeout: TimeInterval = 300
    ) throws -> (output: String, exitCode: Int32) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: command)
        process.arguments = arguments
        if let currentDirectory {
            process.currentDirectoryURL = currentDirectory
        }
        if !environment.isEmpty {
            process.environment = ProcessInfo.processInfo.environment.merging(environment) { _, new in new }
        }

        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe

        lock.lock()
        processes.append(process)
        lock.unlock()

        try process.run()

        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.1)
        }

        if process.isRunning {
            process.terminate()
        }

        process.waitUntilExit()

        lock.lock()
        processes.removeAll { $0 === process }
        lock.unlock()

        let outputData = outPipe.fileHandleForReading.readDataToEndOfFile()
        let errorData = errPipe.fileHandleForReading.readDataToEndOfFile()
        let output = (String(data: outputData, encoding: .utf8) ?? "") + (String(data: errorData, encoding: .utf8) ?? "")

        return (output, process.terminationStatus)
    }

    public func terminateAll() {
        lock.lock()
        let running = processes
        processes.removeAll()
        lock.unlock()

        for process in running where process.isRunning {
            process.terminate()
        }
    }
}

public struct ToolExecutionContext: Sendable {
    public let profile: IdentityProfile
    public let runtime: RuntimeConfig
    public let mirror: WorkspaceMirror
    public let capability: CapabilityToken

    public init(profile: IdentityProfile, runtime: RuntimeConfig, mirror: WorkspaceMirror, capability: CapabilityToken) {
        self.profile = profile
        self.runtime = runtime
        self.mirror = mirror
        self.capability = capability
    }
}

public final class ToolExecutor: @unchecked Sendable {
    private let processes = SubprocessManager()

    public init() {}

    public func terminateAll() {
        processes.terminateAll()
    }

    public func execute(_ contract: ExecutionContract, context: ToolExecutionContext) -> ExecutionResult {
        do {
            switch contract.tool {
            case .filesystemRead:
                return try executeFileRead(contract, context: context)
            case .filesystemWrite:
                return try executeFileWrite(contract, context: context)
            case .shell:
                return try executeShell(contract, context: context)
            case .git:
                return try executeGit(contract, context: context)
            case .webFetch:
                return try executeWebFetch(contract, context: context)
            case .browserAction:
                return try executeBrowserAction(contract, context: context)
            case .testRunner:
                return try executeTestRunner(context: context)
            case .linter:
                return try executeLinter(context: context)
            }
        } catch {
            return ExecutionResult(success: false, summary: "Execution failed", output: String(describing: error))
        }
    }

    private func executeFileRead(_ contract: ExecutionContract, context: ToolExecutionContext) throws -> ExecutionResult {
        guard let relativePath = contract.exactArgs["relativePath"]?.stringValue else {
            throw NSError(domain: "ToolExecutor", code: 1, userInfo: [NSLocalizedDescriptionKey: "relativePath required"])
        }

        let content = try context.mirror.read(relativePath: relativePath)
        return ExecutionResult(success: true, summary: "Read file", output: content)
    }

    private func executeFileWrite(_ contract: ExecutionContract, context: ToolExecutionContext) throws -> ExecutionResult {
        guard let relativePath = contract.exactArgs["relativePath"]?.stringValue,
              let content = contract.exactArgs["content"]?.stringValue else {
            throw NSError(domain: "ToolExecutor", code: 1, userInfo: [NSLocalizedDescriptionKey: "relativePath and content required"])
        }

        try context.mirror.write(relativePath: relativePath, content: content)
        return ExecutionResult(success: true, summary: "Wrote file to workspace mirror", output: relativePath)
    }

    private func executeShell(_ contract: ExecutionContract, context: ToolExecutionContext) throws -> ExecutionResult {
        guard let command = contract.exactArgs["command"]?.stringValue else {
            throw NSError(domain: "ToolExecutor", code: 1, userInfo: [NSLocalizedDescriptionKey: "command required"])
        }

        let parts = command.split(separator: " ").map(String.init)
        guard let executable = parts.first else {
            throw NSError(domain: "ToolExecutor", code: 1, userInfo: [NSLocalizedDescriptionKey: "empty command"])
        }

        guard context.profile.policy.shellAllowlist.contains(executable) else {
            throw NSError(domain: "ToolExecutor", code: 1, userInfo: [NSLocalizedDescriptionKey: "command not allowlisted"])
        }

        let absoluteExecutable = executable.hasPrefix("/") ? executable : "/usr/bin/env"
        let args = absoluteExecutable == "/usr/bin/env" ? parts : Array(parts.dropFirst())

        let result = try processes.run(
            command: absoluteExecutable,
            arguments: args,
            currentDirectory: context.mirror.mirrorRoot
        )

        return ExecutionResult(
            success: result.exitCode == 0,
            summary: "Shell command finished",
            output: result.output
        )
    }

    private func executeGit(_ contract: ExecutionContract, context: ToolExecutionContext) throws -> ExecutionResult {
        guard let command = contract.exactArgs["command"]?.stringValue else {
            throw NSError(domain: "ToolExecutor", code: 1, userInfo: [NSLocalizedDescriptionKey: "git command required"])
        }

        let full = command.split(separator: " ").map(String.init)
        guard full.first == "git" else {
            throw NSError(domain: "ToolExecutor", code: 1, userInfo: [NSLocalizedDescriptionKey: "only git commands supported"])
        }

        if command.contains(" push") {
            throw NSError(domain: "ToolExecutor", code: 1, userInfo: [NSLocalizedDescriptionKey: "git push blocked"])
        }

        let allowedSubcommands = ["status", "diff", "checkout", "switch", "branch", "add", "commit"]
        if full.count < 2 || !allowedSubcommands.contains(full[1]) {
            throw NSError(domain: "ToolExecutor", code: 1, userInfo: [NSLocalizedDescriptionKey: "git subcommand not allowed"])
        }

        let result = try processes.run(
            command: "/usr/bin/env",
            arguments: full,
            currentDirectory: context.mirror.mirrorRoot
        )

        return ExecutionResult(success: result.exitCode == 0, summary: "Git command finished", output: result.output)
    }

    private func executeWebFetch(_ contract: ExecutionContract, context: ToolExecutionContext) throws -> ExecutionResult {
        if context.runtime.offlineMode {
            throw NSError(domain: "ToolExecutor", code: 1, userInfo: [NSLocalizedDescriptionKey: "offline mode enabled"])
        }

        guard let urlString = contract.exactArgs["url"]?.stringValue,
              let url = URL(string: urlString),
              let host = url.host?.lowercased() else {
            throw NSError(domain: "ToolExecutor", code: 1, userInfo: [NSLocalizedDescriptionKey: "valid URL required"])
        }

        guard context.profile.policy.domainAllowlist.map(\.host).contains(host) else {
            throw NSError(domain: "ToolExecutor", code: 1, userInfo: [NSLocalizedDescriptionKey: "domain not allowlisted"])
        }

        let data = try Data(contentsOf: url)
        let text = String(data: data, encoding: .utf8) ?? ""
        let resultText = PromptInjectionGuard.sanitizeWebContent(text)

        return ExecutionResult(success: true, summary: "Fetched web content", output: resultText)
    }

    private func executeBrowserAction(_ contract: ExecutionContract, context: ToolExecutionContext) throws -> ExecutionResult {
        guard let script = contract.exactArgs["script"]?.stringValue else {
            throw NSError(domain: "ToolExecutor", code: 1, userInfo: [NSLocalizedDescriptionKey: "script required for browser.action"])
        }

        let tempScriptUrl = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".js")
        try script.write(to: tempScriptUrl, atomically: true, encoding: .utf8)

        defer {
            try? FileManager.default.removeItem(at: tempScriptUrl)
        }

        let executeRoot = context.mirror.mirrorRoot.appendingPathComponent("electron-geepus")
        
        // Ensure playwright is accessible by running from within the electron-geepus directory
        let result = try processes.run(
            command: "/usr/bin/env",
            arguments: ["node", tempScriptUrl.path],
            currentDirectory: executeRoot
        )

        return ExecutionResult(
            success: result.exitCode == 0,
            summary: result.exitCode == 0 ? "Browser action succeeded" : "Browser action failed",
            output: result.output.isEmpty ? "No output." : result.output
        )
    }

    private func executeTestRunner(context: ToolExecutionContext) throws -> ExecutionResult {
        let result = try processes.run(
            command: "/usr/bin/env",
            arguments: ["swift", "test"],
            currentDirectory: context.mirror.mirrorRoot
        )

        return ExecutionResult(success: result.exitCode == 0, summary: "Tests completed", output: result.output)
    }

    private func executeLinter(context: ToolExecutionContext) throws -> ExecutionResult {
        let script = "set -e; if command -v swift-format >/dev/null 2>&1; then swift-format lint -r .; else echo 'swift-format not installed; lint skipped safely'; fi"

        let result = try processes.run(
            command: "/bin/zsh",
            arguments: ["-lc", script],
            currentDirectory: context.mirror.mirrorRoot
        )

        return ExecutionResult(success: result.exitCode == 0, summary: "Linter completed", output: result.output)
    }
}
