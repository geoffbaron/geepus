import AppKit

enum QuickAskDialog {
    @MainActor
    static func prompt(initial: String) -> String? {
        NSApplication.shared.activate(ignoringOtherApps: true)

        let alert = NSAlert()
        alert.messageText = "Ask Geepus"
        alert.informativeText = "What do you want Geepus to help with?"
        alert.addButton(withTitle: "Ask")
        alert.addButton(withTitle: "Cancel")

        let field = NSTextField(string: initial)
        field.placeholderString = "Type your request here"
        field.font = NSFont.systemFont(ofSize: 15)
        field.frame = NSRect(x: 0, y: 0, width: 520, height: 24)

        let container = NSView(frame: NSRect(x: 0, y: 0, width: 520, height: 26))
        container.addSubview(field)
        field.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            field.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            field.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            field.topAnchor.constraint(equalTo: container.topAnchor),
            field.bottomAnchor.constraint(equalTo: container.bottomAnchor)
        ])

        alert.accessoryView = container

        DispatchQueue.main.async {
            alert.window.makeFirstResponder(field)
        }

        let response = alert.runModal()
        guard response == .alertFirstButtonReturn else { return nil }

        let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }
}
