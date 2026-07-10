import AssistantShared
#if canImport(AppKit)
import AppKit
#endif
import Darwin
import Foundation
import SwiftUI

@MainActor
final class AppViewModel: ObservableObject {
    @Published var settings: AppSettings
    @Published var selectedRecipe: SafeRecipe = .research
    @Published var taskInput: String = ""
    @Published var jarvisResponse: String = "Hi, I'm Geepus. Tell me what you want to get done."
    @Published var isGeepusThinking = false
    @Published var plan: AssistantPlan?
    @Published var logs: [String] = []
    @Published var approvals: [String] = []
    @Published var isRunning = false

    @Published var apiKeyInput: String = ""
    @Published var showAPIKey = false
    @Published var hasSavedAPIKey = false
    @Published var connectorTestPrompt = "Return one sentence confirming this connector is live."
    @Published var connectorTestResult = ""
    @Published var isTestingConnector = false
    @Published var availableAPIModels: [APIModelDescriptor] = []
    @Published var isLoadingAPIModels = false
    @Published var isRestartingDaemon = false
    @Published var showTechnicalDetails = false

    private let configStore: SecureConfigStore
    private let daemon = DaemonClient()
    private let recipeBuilder = RecipeBuilder()
    private let router: ModelRouter
    private let openAIProvider = OpenAICompatibleProvider()
    private let workspacePath: String
    private var attemptedAutoDaemonRecovery = false
    private var attemptedModelBootstrap = false
    private var maintenanceTask: Task<Void, Never>?
    private var lastDaemonHealthyState: Bool?

    var connectionBadgeText: String {
        if hasSavedAPIKey {
            return "Connected"
        }
        return "Needs setup"
    }

    var connectionBadgeColor: Color {
        hasSavedAPIKey ? .green : .orange
    }

    init() {
        let appSupport = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/GeepusAssistant", isDirectory: true)

        self.configStore = try! SecureConfigStore(baseDirectory: appSupport)
        self.workspacePath = FileManager.default.currentDirectoryPath

        let defaults = AppSettings.defaultSettings(workspace: workspacePath)
        self.settings = (try? configStore.load(defaults: defaults)) ?? defaults

        self.router = ModelRouter(providers: [
            StubLocalProvider(backend: .ollama),
            StubLocalProvider(backend: .llamaCpp),
            StubLocalProvider(backend: .mlx),
            openAIProvider
        ])

        if let storedKey = try? APIKeyStore.loadOpenAIKey() {
            self.hasSavedAPIKey = !storedKey.isEmpty
        } else {
            self.hasSavedAPIKey = false
        }

        if settings.modelSelection.backend == .api || hasSavedAPIKey {
            settings.modelSelection.backend = .api
            if settings.modelSelection.mode == .offline {
                settings.modelSelection.mode = .heavyReasoning
            }
            settings.modelSelection.modelIdentifier = settings.apiModel
        }
    }

    var activeProfile: IdentityProfile {
        if let active = settings.activeProfileID,
           let profile = settings.profiles.first(where: { $0.id == active }) {
            return profile
        }
        return settings.profiles[0]
    }

    func selectProfile(_ id: UUID) {
        settings.activeProfileID = id
        saveSettings()
    }

    func selectModelMode(_ mode: ModelMode) {
        settings.modelSelection.mode = mode
        if mode == .offline, settings.modelSelection.backend == .api {
            settings.modelSelection.backend = .mlx
        }
        saveSettings()
    }

    func selectBackend(_ backend: ModelBackend) {
        if settings.modelSelection.mode == .offline && backend == .api {
            logs.append("Offline mode blocks API backend")
            return
        }

        settings.modelSelection.backend = backend
        if backend == .api {
            settings.modelSelection.modelIdentifier = settings.apiModel
        }
        saveSettings()
    }

    func updateAPIBaseURL(_ value: String) {
        settings.apiBaseURL = value
        saveSettings()
    }

    func updateAPIModel(_ value: String) {
        settings.apiModel = value
        if settings.modelSelection.backend == .api {
            settings.modelSelection.modelIdentifier = value
        }
        saveSettings()
    }

    func askGeepus(prompt overridePrompt: String? = nil) {
        let prompt = (overridePrompt ?? taskInput).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else {
            jarvisResponse = "Tell me what you want help with first."
            return
        }

        if let overridePrompt {
            taskInput = overridePrompt
        }

        isGeepusThinking = true
        jarvisResponse = "Geepus is thinking..."

        Task {
            do {
                let selection = try await preferredModelSelection()
                let response = try await router.generate(
                    request: ModelRequest(
                        prompt: prompt,
                        systemPrompt: "You are Geepus, a practical personal chief-of-staff. Give concise, actionable help for life planning and building technology projects.",
                        mode: selection.backend == .api ? .heavyReasoning : settings.modelSelection.mode
                    ),
                    selection: selection,
                    connector: selection.backend == .api ? APIConnectorConfig(baseURL: settings.apiBaseURL) : nil
                )
                jarvisResponse = response.text
                logs.append("Geepus responded with \(response.tokenStats.completionTokens) completion tokens")
            } catch {
                jarvisResponse = "I couldn't answer yet: \(error.localizedDescription)"
                logs.append("Ask Geepus failed: \(error)")
            }
            isGeepusThinking = false
        }
    }

    func usePromptTemplate(_ text: String) {
        taskInput = text
    }

    func connectGeepus() {
        let typedKey = apiKeyInput.trimmingCharacters(in: .whitespacesAndNewlines)
        if !typedKey.isEmpty {
            saveAPIKey()
        } else if !hasSavedAPIKey {
            connectorTestResult = "Paste your API key first, then tap Connect Geepus."
            return
        }

        Task {
            await refreshAccessibleModels(autoSelect: true, emitLogs: true)
            testAPIConnector()
        }
    }

    func saveAPIKey() {
        let trimmed = apiKeyInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            logs.append("API key is empty")
            return
        }

        do {
            try APIKeyStore.saveOpenAIKey(trimmed)
            hasSavedAPIKey = true
            apiKeyInput = ""
            settings.modelSelection.backend = .api
            if settings.modelSelection.mode == .offline {
                settings.modelSelection.mode = .heavyReasoning
            }
            settings.modelSelection.modelIdentifier = settings.apiModel
            saveSettings()
            logs.append("Saved API key to Keychain")
            Task {
                await refreshAccessibleModels(autoSelect: true, emitLogs: true)
            }
        } catch {
            logs.append("Failed to save API key: \(error)")
        }
    }

    func pasteAPIKeyFromClipboard() {
#if canImport(AppKit)
        let value = NSPasteboard.general.string(forType: .string) ?? ""
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            logs.append("Clipboard is empty")
            return
        }
        apiKeyInput = trimmed
        logs.append("Pasted API key from clipboard")
#else
        logs.append("Clipboard paste is not available on this platform")
#endif
    }

    func clearAPIKey() {
        do {
            try APIKeyStore.clearOpenAIKey()
            hasSavedAPIKey = false
            availableAPIModels = []
            logs.append("Cleared API key")
        } catch {
            logs.append("Failed to clear API key: \(error)")
        }
    }

    func testAPIConnector() {
        isTestingConnector = true
        connectorTestResult = "Testing connector..."

        Task {
            do {
                var selection = settings.modelSelection
                selection.backend = .api
                if let accessibleModel = try await ensureSelectedAccessibleModelOrFallback() {
                    selection.modelIdentifier = accessibleModel
                } else {
                    connectorTestResult = "No accessible API model found yet. Click Find Models I Can Use."
                    logs.append("Connector test skipped: no accessible API model")
                    isTestingConnector = false
                    return
                }

                let response = try await router.generate(
                    request: ModelRequest(
                        prompt: connectorTestPrompt,
                        systemPrompt: "You are a concise test assistant.",
                        mode: .heavyReasoning
                    ),
                    selection: selection,
                    connector: APIConnectorConfig(baseURL: settings.apiBaseURL)
                )

                connectorTestResult = response.text
                logs.append("Connector test succeeded")
            } catch {
                connectorTestResult = "Test failed: \(error.localizedDescription)"
                logs.append("Connector test failed: \(error)")
            }
            isTestingConnector = false
        }
    }

    func listMyAPIModels() {
        isLoadingAPIModels = true

        Task {
            await refreshAccessibleModels(autoSelect: true, emitLogs: true)
        }
    }

    func useDiscoveredModel(_ modelID: String) {
        updateAPIModel(modelID)
        settings.modelSelection.backend = .api
        if settings.modelSelection.mode == .offline {
            settings.modelSelection.mode = .heavyReasoning
        }
        settings.modelSelection.modelIdentifier = modelID
        saveSettings()
        logs.append("Selected model \(modelID)")
    }

    var selectableAPIModels: [String] {
        if availableAPIModels.isEmpty {
            return [settings.apiModel]
        }
        return availableAPIModels.map(\.id)
    }

    func generatePlan() {
        let recipe = suggestedRecipe(for: taskInput)
        selectedRecipe = recipe
        let contracts = recipeBuilder.build(recipe: recipe, task: taskInput)
        let steps = contracts.map {
            PlanStep(
                title: $0.intent,
                detail: "Tool: \($0.tool.rawValue) | Risk: \($0.riskLevel.rawValue)",
                requiresApproval: $0.riskLevel != .low
            )
        }

        plan = AssistantPlan(steps: steps)

        Task {
            do {
                let selection = try await preferredModelSelection()

                let response = try await router.generate(
                    request: ModelRequest(
                        prompt: "Generate a concise safe execution plan for: \(taskInput)",
                        systemPrompt: "You are Geepus, a practical chief-of-staff. Provide concise step-by-step plan.",
                        mode: selection.backend == .api ? .heavyReasoning : settings.modelSelection.mode
                    ),
                    selection: selection,
                    connector: selection.backend == .api ? APIConnectorConfig(baseURL: settings.apiBaseURL) : nil
                )
                jarvisResponse = response.text
                logs.append("Plan generated")
            } catch {
                logs.append("Plan model error: \(error)")
            }
        }
    }

    func runPlan() {
        let recipe = suggestedRecipe(for: taskInput)
        selectedRecipe = recipe
        let contracts = recipeBuilder.build(recipe: recipe, task: taskInput)
        if plan == nil {
            let steps = contracts.map {
                PlanStep(
                    title: $0.intent,
                    detail: "Tool: \($0.tool.rawValue) | Risk: \($0.riskLevel.rawValue)",
                    requiresApproval: $0.riskLevel != .low
                )
            }
            plan = AssistantPlan(steps: steps)
        }
        let runID = plan?.runID ?? UUID()
        isRunning = true

        Task {
            do {
                let capability = try issueCapability(for: activeProfile)
                let report = try await daemon.run(
                    runID: runID,
                    contracts: contracts,
                    profile: activeProfile,
                    capability: capability,
                    runtime: settings.runtime,
                    workspacePath: workspacePath
                )

                for result in report.results {
                    logs.append("[\(result.success ? "ok" : "fail")] \(result.summary)")
                    if result.summary == "Approval required" {
                        approvals.append(result.output)
                    }
                }
                jarvisResponse = report.results.map(\.summary).joined(separator: "\n")
                logs.append(report.halted ? "Run halted by user" : "Run complete")
            } catch {
                logs.append("Run failed: \(error)")
            }
            isRunning = false
        }
    }

    func hardStop() {
        Task {
            do {
                let response = try await daemon.hardStop()
                logs.append(response)
            } catch {
                logs.append("Failed to send stop: \(error)")
            }
            isRunning = false
        }
    }

    func refreshStatus() {
        Task {
            do {
                let status = try await daemon.status()
                logs.append("Daemon status: \(status)")
            } catch {
                logs.append("Status failed: \(error)")
                await restartDaemonServiceInternal(manualTrigger: false)
            }
        }
    }

    func ensureDaemonAvailable() {
        guard !attemptedAutoDaemonRecovery else { return }
        attemptedAutoDaemonRecovery = true

        Task {
            do {
                let status = try await daemon.status()
                logs.append("Daemon status: \(status)")
            } catch {
                logs.append("Daemon not reachable. Attempting auto-restart...")
                await restartDaemonServiceInternal(manualTrigger: false)
            }

            await bootstrapModelAccessIfNeeded()
        }
    }

    func startAutoMaintenance() {
        guard maintenanceTask == nil else { return }

        maintenanceTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 45_000_000_000)
                if Task.isCancelled { break }
                await performMaintenanceTick()
            }
        }
    }

    func restartDaemonService() {
        Task {
            await restartDaemonServiceInternal(manualTrigger: true)
        }
    }

    func restartAssistantApp() {
#if canImport(AppKit)
        guard let executablePath = CommandLine.arguments.first, !executablePath.isEmpty else {
            logs.append("Unable to restart app: executable path not found")
            return
        }

        let escapedPath = executablePath.replacingOccurrences(of: "'", with: "'\"'\"'")
        let script = "nohup '\(escapedPath)' >/tmp/geepus-assistant.log 2>&1 &"

        do {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/zsh")
            process.arguments = ["-lc", script]
            process.currentDirectoryURL = URL(fileURLWithPath: workspacePath)
            try process.run()
            logs.append("Restarting assistant app...")

            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                NSApplication.shared.terminate(nil)
            }
        } catch {
            logs.append("Failed to restart app: \(error)")
        }
#else
        logs.append("App restart is not available on this platform")
#endif
    }

    private func preferredModelSelection() async throws -> ModelSelection {
        if hasSavedAPIKey {
            if let selectedModel = try await ensureSelectedAccessibleModelOrFallback() {
                return ModelSelection(mode: .heavyReasoning, backend: .api, modelIdentifier: selectedModel)
            }
        }

        var fallback = settings.modelSelection
        if fallback.backend == .api {
            fallback.backend = .mlx
            fallback.mode = .offline
            logs.append("No accessible API model found. Falling back to local mode.")
        }
        return fallback
    }

    @discardableResult
    private func ensureSelectedAccessibleModelOrFallback() async throws -> String? {
        if let model = availableAPIModels.first(where: { $0.id == settings.apiModel })?.id {
            return model
        }

        if availableAPIModels.isEmpty {
            await refreshAccessibleModels(autoSelect: true, emitLogs: false)
        }

        if let first = availableAPIModels.first?.id {
            if first != settings.apiModel {
                useDiscoveredModel(first)
            }
            return first
        }

        return nil
    }

    private func refreshAccessibleModels(autoSelect: Bool, emitLogs: Bool) async {
        guard hasSavedAPIKey else {
            if emitLogs {
                logs.append("Save an API key first.")
            }
            isLoadingAPIModels = false
            return
        }

        if !isLoadingAPIModels {
            isLoadingAPIModels = true
        }
        defer { isLoadingAPIModels = false }

        do {
            let models = try await openAIProvider.listAccessibleChatModels(
                connector: APIConnectorConfig(baseURL: settings.apiBaseURL)
            )
            availableAPIModels = models

            if models.isEmpty {
                if emitLogs {
                    logs.append("No accessible chat models found for this key/project")
                }
                return
            }

            if emitLogs {
                logs.append("Loaded \(models.count) accessible chat models")
            }

            if autoSelect && !models.map(\.id).contains(settings.apiModel) {
                useDiscoveredModel(models[0].id)
                if emitLogs {
                    logs.append("Switched to accessible model \(models[0].id)")
                }
            }
        } catch {
            if emitLogs {
                logs.append("List models failed: \(error)")
            }
        }
    }

    private func bootstrapModelAccessIfNeeded() async {
        guard hasSavedAPIKey else { return }
        guard !attemptedModelBootstrap else { return }
        attemptedModelBootstrap = true

        await refreshAccessibleModels(autoSelect: true, emitLogs: false)

        if availableAPIModels.isEmpty {
            logs.append("Could not auto-detect accessible API models yet. Use 'Find Models I Can Use'.")
        } else {
            logs.append("Ready with model \(settings.apiModel)")
        }
    }

    private func issueCapability(for profile: IdentityProfile) throws -> CapabilityToken {
        let authority = CapabilityAuthority()
        let claims = CapabilityClaims(
            profileID: profile.id,
            expiresAt: Date().addingTimeInterval(15 * 60),
            fileScopes: [
                FileScope(root: profile.policy.workspaceRoot, access: .readOnly),
                FileScope(root: profile.policy.workspaceRoot, access: .write)
            ],
            shellScope: ShellScope(allowlistedCommands: profile.policy.shellAllowlist),
            networkScope: profile.policy.domainAllowlist.isEmpty ? nil : NetworkScope(domains: profile.policy.domainAllowlist.map(\.host)),
            gitScope: GitScope(allowPush: false, allowBranchCreate: true),
            automationScope: AutomationScope(allowedBundleIDs: profile.policy.allowExternalAppAutomation)
        )
        return try authority.issueToken(claims: claims)
    }

    private func saveSettings() {
        do {
            try configStore.save(settings)
        } catch {
            logs.append("Failed to save settings: \(error)")
        }
    }

    private func suggestedRecipe(for task: String) -> SafeRecipe {
        let text = task.lowercased()

        if text.contains("document") || text.contains("write-up") || text.contains("summary") {
            return .documentation
        }
        if text.contains("refactor") || text.contains("cleanup") {
            return .refactor
        }
        if text.contains("build") || text.contains("code") || text.contains("bug") || text.contains("feature") {
            return .codeChange
        }
        return .research
    }

    private func restartDaemonServiceInternal(manualTrigger: Bool) async {
        if isRestartingDaemon { return }
        isRestartingDaemon = true
        defer { isRestartingDaemon = false }

        do {
            let workspace = workspacePath
            let result = try await Task.detached(priority: .userInitiated) {
                try DaemonServiceManager.restart(workspacePath: workspace)
            }.value

            daemon.reconnect()
            logs.append(result)

            let status = try await daemon.status()
            logs.append("Daemon status: \(status)")
            lastDaemonHealthyState = true
        } catch {
            if manualTrigger {
                logs.append("Manual daemon restart failed: \(error)")
            } else {
                logs.append("Auto daemon restart failed: \(error)")
            }
            lastDaemonHealthyState = false
        }
    }

    private func performMaintenanceTick() async {
        do {
            _ = try await daemon.status()
            if lastDaemonHealthyState == false {
                logs.append("Engine recovered and is reachable again.")
            }
            lastDaemonHealthyState = true
        } catch {
            if lastDaemonHealthyState != false {
                logs.append("Engine unreachable. Auto-restarting...")
            }
            lastDaemonHealthyState = false
            await restartDaemonServiceInternal(manualTrigger: false)
        }

        if hasSavedAPIKey && availableAPIModels.isEmpty && !isLoadingAPIModels {
            await refreshAccessibleModels(autoSelect: true, emitLogs: false)
        }
    }
}

@MainActor
final class DaemonClient {
    private var connection: NSXPCConnection

    init() {
        connection = DaemonClient.makeConnection()
    }

    func reconnect() {
        connection.invalidate()
        connection = DaemonClient.makeConnection()
    }

    private static func makeConnection() -> NSXPCConnection {
        let connection = NSXPCConnection(machServiceName: "com.geepus.AssistantDaemon", options: [])
        connection.remoteObjectInterface = NSXPCInterface(with: AssistantDaemonXPCProtocol.self)
        connection.resume()
        return connection
    }

    func run(
        runID: UUID,
        contracts: [ExecutionContract],
        profile: IdentityProfile,
        capability: CapabilityToken,
        runtime: RuntimeConfig,
        workspacePath: String
    ) async throws -> LoopReport {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601

        let request = AssistantRunRequest(
            runID: runID.uuidString,
            contractsData: try encoder.encode(contracts),
            profileData: try encoder.encode(profile),
            capabilityData: try encoder.encode(capability),
            runtimeData: try encoder.encode(runtime),
            workspacePath: workspacePath
        )

        return try await withCheckedThrowingContinuation { continuation in
            guard let proxy = connection.remoteObjectProxyWithErrorHandler({ error in
                continuation.resume(throwing: error)
            }) as? AssistantDaemonXPCProtocol else {
                continuation.resume(throwing: NSError(domain: "DaemonClient", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid daemon interface"]))
                return
            }

            proxy.run(request) { reply in
                if !reply.success {
                    continuation.resume(throwing: NSError(domain: "DaemonClient", code: 2, userInfo: [NSLocalizedDescriptionKey: reply.message]))
                    return
                }

                guard let data = reply.reportData else {
                    continuation.resume(throwing: NSError(domain: "DaemonClient", code: 3, userInfo: [NSLocalizedDescriptionKey: "Missing report payload"]))
                    return
                }

                do {
                    let decoder = JSONDecoder()
                    let report = try decoder.decode(LoopReport.self, from: data)
                    continuation.resume(returning: report)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    func hardStop() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            guard let proxy = connection.remoteObjectProxyWithErrorHandler({ error in
                continuation.resume(throwing: error)
            }) as? AssistantDaemonXPCProtocol else {
                continuation.resume(throwing: NSError(domain: "DaemonClient", code: 4, userInfo: [NSLocalizedDescriptionKey: "Invalid daemon interface"]))
                return
            }

            proxy.hardStop { status in
                continuation.resume(returning: status as String)
            }
        }
    }

    func status() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            guard let proxy = connection.remoteObjectProxyWithErrorHandler({ error in
                continuation.resume(throwing: error)
            }) as? AssistantDaemonXPCProtocol else {
                continuation.resume(throwing: NSError(domain: "DaemonClient", code: 5, userInfo: [NSLocalizedDescriptionKey: "Invalid daemon interface"]))
                return
            }

            proxy.status { status in
                continuation.resume(returning: status as String)
            }
        }
    }
}

private enum DaemonServiceManager {
    private static let label = "com.geepus.AssistantDaemon"

    static func restart(workspacePath: String) throws -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let launchAgents = home.appendingPathComponent("Library/LaunchAgents", isDirectory: true)
        try FileManager.default.createDirectory(at: launchAgents, withIntermediateDirectories: true)

        let sourcePlist = URL(fileURLWithPath: workspacePath)
            .appendingPathComponent("Deployment/com.geepus.AssistantDaemon.plist")
        let targetPlist = launchAgents.appendingPathComponent("com.geepus.AssistantDaemon.plist")

        if FileManager.default.fileExists(atPath: sourcePlist.path) {
            if FileManager.default.fileExists(atPath: targetPlist.path) {
                try? FileManager.default.removeItem(at: targetPlist)
            }
            try FileManager.default.copyItem(at: sourcePlist, to: targetPlist)
        }

        let uid = getuid()
        let domain = "gui/\(uid)"
        let service = "\(domain)/\(label)"

        _ = try runLaunchctl(args: ["bootout", service], ignoreFailure: true)
        _ = try runLaunchctl(args: ["bootstrap", domain, targetPlist.path], ignoreFailure: false)
        let kickstart = try runLaunchctl(args: ["kickstart", "-k", service], ignoreFailure: false)

        if kickstart.isEmpty {
            return "Daemon restarted from UI"
        }
        return "Daemon restarted from UI: \(kickstart)"
    }

    private static func runLaunchctl(args: [String], ignoreFailure: Bool) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = args

        let outputPipe = Pipe()
        let errorPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = errorPipe

        try process.run()
        process.waitUntilExit()

        let output = String(data: outputPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let err = String(data: errorPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let combined = (output + err).trimmingCharacters(in: .whitespacesAndNewlines)

        if process.terminationStatus != 0 && !ignoreFailure {
            throw NSError(
                domain: "DaemonServiceManager",
                code: Int(process.terminationStatus),
                userInfo: [NSLocalizedDescriptionKey: combined.isEmpty ? "launchctl failed" : combined]
            )
        }

        return combined
    }
}
