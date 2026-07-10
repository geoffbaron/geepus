import Foundation

public struct ModelRouterAdapter: Sendable {
    private let core: CoreModelRouter
    private let logger: (@Sendable (String) -> Void)?

    public init(core: CoreModelRouter, logger: (@Sendable (String) -> Void)? = nil) {
        self.core = core
        self.logger = logger
    }

    public func generate(
        request: ModelRequest,
        selection: ModelSelection,
        connector: APIConnectorConfig? = nil
    ) async throws -> ModelResponse {
        logger?("Model chosen: \(selection.modelIdentifier) via \(selection.backend.rawValue). Reasoning mode: \(selection.mode.rawValue)")
        
        let response = try await core.generate(request: request, selection: selection, connector: connector)
        
        if request.expectedSchema != nil {
            logger?("Validating output against expected schema...")
            if let data = response.text.data(using: .utf8) {
                do {
                    _ = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
                } catch {
                    logger?("Validation failed: Output is not valid JSON")
                    throw ModelRouterError.invalidResponse
                }
            } else {
                logger?("Validation failed: Output cannot be encoded as UTF8")
                throw ModelRouterError.invalidResponse
            }
        }
        
        return response
    }
}
