import AssistantShared
import SwiftUI
#if canImport(AppKit)
import AppKit
#endif

@main
struct AssistantUIApp: App {
    @StateObject private var viewModel = AppViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(viewModel)
                .frame(minWidth: 1000, minHeight: 760)
        }
    }
}

struct ContentView: View {
    @EnvironmentObject var vm: AppViewModel
    @State private var showSetup = false

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Color(red: 0.07, green: 0.08, blue: 0.11), Color(red: 0.2, green: 0.22, blue: 0.28)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            VStack(alignment: .leading, spacing: 14) {
                header

                GroupBox("Geepus Reply") {
                    ScrollView {
                        Text(vm.jarvisResponse)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .font(.system(.body, design: .monospaced))
                            .padding(.vertical, 4)
                    }
                    .frame(minHeight: 420)
                }

                GroupBox("Ask Geepus") {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Use Quick Ask. It opens a focused input pop-up so typing always works.")
                            .foregroundStyle(.secondary)

                        HStack {
                            Button(vm.isGeepusThinking ? "Thinking..." : "Quick Ask") {
                                openQuickAsk(initial: vm.taskInput)
                            }
                            .disabled(vm.isGeepusThinking)

                            Button("Ask Using Current Draft") {
                                vm.askGeepus()
                            }
                            .disabled(vm.isGeepusThinking || vm.taskInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }

                        HStack {
                            Button("Plan my week") {
                                openQuickAsk(initial: "Help me plan this week with priorities, time blocks, and must-do items.")
                            }

                            Button("Build my project") {
                                openQuickAsk(initial: "Help me break my project into the next five build steps and start with step one.")
                            }

                            Button("Life admin") {
                                openQuickAsk(initial: "Help me organize personal tasks, deadlines, and reminders for this week.")
                            }
                        }
                    }
                }

                if !vm.connectorTestResult.isEmpty {
                    Text(vm.connectorTestResult)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }
            .padding(20)
            .frame(maxWidth: 1040)
        }
        .sheet(isPresented: $showSetup) {
            SetupSheet(vm: vm)
        }
        .task {
            vm.ensureDaemonAvailable()
            vm.startAutoMaintenance()
        }
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Geepus")
                    .font(.system(size: 34, weight: .bold))
                Text("Personal AI assistant")
                    .foregroundStyle(.secondary)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 8) {
                Text(vm.connectionBadgeText)
                    .foregroundStyle(vm.connectionBadgeColor)

                HStack {
                    Button("Setup") {
                        showSetup = true
                    }

                    Button("Restart App") {
                        vm.restartAssistantApp()
                    }
                }
            }
        }
    }

#if canImport(AppKit)
    private func openQuickAsk(initial: String) {
        if let prompt = QuickAskDialog.prompt(initial: initial) {
            vm.askGeepus(prompt: prompt)
        }
    }
#else
    private func openQuickAsk(initial: String) {
        vm.usePromptTemplate(initial)
    }
#endif
}

struct SetupSheet: View {
    @ObservedObject var vm: AppViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Setup Geepus")
                .font(.title2.bold())

            Text("You only need this when changing API key or model.")
                .foregroundStyle(.secondary)

            Picker("Model", selection: Binding(
                get: { vm.settings.apiModel },
                set: { vm.useDiscoveredModel($0) }
            )) {
                ForEach(vm.selectableAPIModels, id: \.self) { modelID in
                    Text(modelID).tag(modelID)
                }
            }

            Toggle("Show API key", isOn: $vm.showAPIKey)

            if vm.showAPIKey {
                TextField("API Key (sk-...)", text: $vm.apiKeyInput)
                    .textFieldStyle(.roundedBorder)
            } else {
                SecureField("API Key (sk-...)", text: $vm.apiKeyInput)
                    .textFieldStyle(.roundedBorder)
            }

            HStack {
                Button("Paste Key") {
                    vm.pasteAPIKeyFromClipboard()
                }

                Button("Connect") {
                    vm.connectGeepus()
                }
                .disabled(vm.isLoadingAPIModels || vm.isTestingConnector)

                Button("Find Models") {
                    vm.listMyAPIModels()
                }
                .disabled(vm.isLoadingAPIModels)

                Button("Test") {
                    vm.testAPIConnector()
                }
                .disabled(vm.isTestingConnector)
            }

            Text(vm.connectorTestResult.isEmpty ? "No connection test yet." : vm.connectorTestResult)
                .font(.caption)
                .foregroundStyle(.secondary)

            Divider()

            HStack {
                Button("Restart Engine") {
                    vm.restartDaemonService()
                }
                .disabled(vm.isRestartingDaemon)

                Button("Check Engine") {
                    vm.refreshStatus()
                }

                Spacer()

                Button("Done") {
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
            }

            if !vm.logs.isEmpty {
                DisclosureGroup("Technical log") {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(Array(vm.logs.suffix(12).enumerated()), id: \.offset) { _, line in
                                Text(line)
                                    .font(.system(.caption, design: .monospaced))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                    .frame(height: 120)
                }
            }
        }
        .padding(18)
        .frame(minWidth: 680, minHeight: 460)
    }
}
