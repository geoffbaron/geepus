import Foundation

public struct ModelFacade: Sendable {
    private let adapter: ModelRouterAdapter

    public init(providers: [any ModelProvider], logger: (@Sendable (String) -> Void)? = nil) {
        let core = CoreModelRouter(providers: providers)
        self.adapter = ModelRouterAdapter(core: core, logger: logger)
    }

    public func generate(
        request: ModelRequest,
        selection: ModelSelection,
        connector: APIConnectorConfig? = nil
    ) async throws -> ModelResponse {
        return try await adapter.generate(request: request, selection: selection, connector: connector)
    }
}

public typealias ModelRouter = ModelFacade
