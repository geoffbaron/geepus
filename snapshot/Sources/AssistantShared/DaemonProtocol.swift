import Foundation

@objc(AssistantRunRequest)
public final class AssistantRunRequest: NSObject, NSSecureCoding {
    public static let supportsSecureCoding: Bool = true

    public let runID: String
    public let contractsData: Data
    public let profileData: Data
    public let capabilityData: Data
    public let runtimeData: Data
    public let workspacePath: String

    public init(runID: String, contractsData: Data, profileData: Data, capabilityData: Data, runtimeData: Data, workspacePath: String) {
        self.runID = runID
        self.contractsData = contractsData
        self.profileData = profileData
        self.capabilityData = capabilityData
        self.runtimeData = runtimeData
        self.workspacePath = workspacePath
    }

    public func encode(with coder: NSCoder) {
        coder.encode(runID, forKey: "runID")
        coder.encode(contractsData, forKey: "contractsData")
        coder.encode(profileData, forKey: "profileData")
        coder.encode(capabilityData, forKey: "capabilityData")
        coder.encode(runtimeData, forKey: "runtimeData")
        coder.encode(workspacePath, forKey: "workspacePath")
    }

    public required init?(coder: NSCoder) {
        guard let runID = coder.decodeObject(of: NSString.self, forKey: "runID") as String?,
              let contractsData = coder.decodeObject(of: NSData.self, forKey: "contractsData") as Data?,
              let profileData = coder.decodeObject(of: NSData.self, forKey: "profileData") as Data?,
              let capabilityData = coder.decodeObject(of: NSData.self, forKey: "capabilityData") as Data?,
              let runtimeData = coder.decodeObject(of: NSData.self, forKey: "runtimeData") as Data?,
              let workspacePath = coder.decodeObject(of: NSString.self, forKey: "workspacePath") as String? else {
            return nil
        }
        self.runID = runID
        self.contractsData = contractsData
        self.profileData = profileData
        self.capabilityData = capabilityData
        self.runtimeData = runtimeData
        self.workspacePath = workspacePath
    }
}

@objc(AssistantRunReply)
public final class AssistantRunReply: NSObject, NSSecureCoding {
    public static let supportsSecureCoding: Bool = true

    public let success: Bool
    public let message: String
    public let reportData: Data?

    public init(success: Bool, message: String, reportData: Data?) {
        self.success = success
        self.message = message
        self.reportData = reportData
    }

    public func encode(with coder: NSCoder) {
        coder.encode(success, forKey: "success")
        coder.encode(message, forKey: "message")
        coder.encode(reportData, forKey: "reportData")
    }

    public required init?(coder: NSCoder) {
        self.success = coder.decodeBool(forKey: "success")
        self.message = coder.decodeObject(of: NSString.self, forKey: "message") as String? ?? ""
        self.reportData = coder.decodeObject(of: NSData.self, forKey: "reportData") as Data?
    }
}

@objc public protocol AssistantDaemonXPCProtocol {
    func run(_ request: AssistantRunRequest, withReply reply: @escaping (AssistantRunReply) -> Void)
    func hardStop(withReply reply: @escaping (NSString) -> Void)
    func status(withReply reply: @escaping (NSString) -> Void)
}
