import AssistantShared
import Foundation

final class ListenerDelegate: NSObject, NSXPCListenerDelegate {
    private let service = DaemonService()

    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection newConnection: NSXPCConnection) -> Bool {
        let interface = NSXPCInterface(with: AssistantDaemonXPCProtocol.self)

        newConnection.exportedInterface = interface
        newConnection.exportedObject = service
        newConnection.resume()
        return true
    }
}

let delegate = ListenerDelegate()
let listener = NSXPCListener(machServiceName: "com.geepus.AssistantDaemon")
listener.delegate = delegate
listener.resume()
RunLoop.main.run()
