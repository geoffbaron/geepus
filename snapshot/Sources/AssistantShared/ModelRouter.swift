import Foundation

public struct ModelRequest: Codable, Sendable {
    public let prompt: String
    public let systemPrompt: String
    public let mode: ModelMode
    public let temperature: Double?
    public let topP: Double?
    public let expectedSchema: String?

    public init(prompt: String, systemPrompt: String, mode: ModelMode, temperature: Double? = nil, topP: Double? = nil, expectedSchema: String? = nil) {
        self.prompt = prompt
        self.systemPrompt = systemPrompt
        self.mode = mode
        self.temperature = temperature
        self.topP = topP
        self.expectedSchema = expectedSchema
    }
}

public struct ModelResponse: Codable, Sendable {
    public let text: String
    public let tokenStats: TokenStats

    public init(text: String, tokenStats: TokenStats) {
        self.text = text
        self.tokenStats = tokenStats
    }
}

public struct APIConnectorConfig: Codable, Sendable {
    public let baseURL: String

    public init(baseURL: String) {
        self.baseURL = baseURL
    }
}

public enum ModelRouterError: Error, LocalizedError {
    case providerUnavailable
    case offlineAPIBlocked
    case missingAPIConnector
    case missingAPIKey
    case invalidBaseURL
    case invalidResponse
    case httpError(Int, String)

    public var errorDescription: String? {
        switch self {
        case .providerUnavailable: return "Provider unavailable"
        case .offlineAPIBlocked: return "Offline mode cannot use API backend"
        case .missingAPIConnector: return "API connector settings are missing"
        case .missingAPIKey: return "API key is missing"
        case .invalidBaseURL: return "Invalid API base URL"
        case .invalidResponse: return "API returned an unreadable response"
        case .httpError(let code, let body): return "API request failed (\(code)): \(body)"
        }
    }
}

public struct APIModelDescriptor: Codable, Sendable, Identifiable {
    public let id: String
    public let ownedBy: String?

    public init(id: String, ownedBy: String?) {
        self.id = id
        self.ownedBy = ownedBy
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case ownedBy = "owned_by"
    }
}

public protocol ModelProvider: Sendable {
    var backend: ModelBackend { get }
    func complete(
        request: ModelRequest,
        modelIdentifier: String,
        connector: APIConnectorConfig?
    ) async throws -> ModelResponse
}

public struct CoreModelRouter: Sendable {
    private let providers: [ModelBackend: any ModelProvider]

    public init(providers: [any ModelProvider]) {
        var map: [ModelBackend: any ModelProvider] = [:]
        for provider in providers {
            map[provider.backend] = provider
        }
        self.providers = map
    }

    public func generate(
        request: ModelRequest,
        selection: ModelSelection,
        connector: APIConnectorConfig? = nil
    ) async throws -> ModelResponse {
        if request.mode == .offline && selection.backend == .api {
            throw ModelRouterError.offlineAPIBlocked
        }

        guard let provider = providers[selection.backend] else {
            throw ModelRouterError.providerUnavailable
        }

        return try await provider.complete(
            request: request,
            modelIdentifier: selection.modelIdentifier,
            connector: connector
        )
    }
}

public struct StubLocalProvider: ModelProvider {
    public let backend: ModelBackend

    public init(backend: ModelBackend) {
        self.backend = backend
    }

    public func complete(
        request: ModelRequest,
        modelIdentifier: String,
        connector: APIConnectorConfig?
    ) async throws -> ModelResponse {
        let stub = "[\(backend.rawValue):\(modelIdentifier)] Generated plan scaffold for: \(request.prompt.prefix(120))"
        return ModelResponse(text: stub, tokenStats: TokenStats(promptTokens: 100, completionTokens: 50))
    }
}

public struct OpenAICompatibleProvider: ModelProvider {
    public let backend: ModelBackend = .api

    public init() {}

    public func complete(
        request: ModelRequest,
        modelIdentifier: String,
        connector: APIConnectorConfig?
    ) async throws -> ModelResponse {
        let (baseURL, apiKey) = try connectorMaterial(connector: connector)
        let endpoint = baseURL.appendingPathComponent("v1/chat/completions")
        var requestURL = authorizedRequest(url: endpoint, apiKey: apiKey)
        requestURL.httpMethod = "POST"
        requestURL.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let payload = ChatCompletionsRequest(
            model: modelIdentifier,
            messages: [
                .init(role: "system", content: request.systemPrompt),
                .init(role: "user", content: request.prompt)
            ],
            temperature: request.temperature,
            topP: request.topP
        )
        requestURL.httpBody = try JSONEncoder().encode(payload)

        let data = try await dataOrThrow(requestURL)

        let decoded = try JSONDecoder().decode(ChatCompletionsResponse.self, from: data)
        guard let text = decoded.choices.first?.message.content, !text.isEmpty else {
            throw ModelRouterError.invalidResponse
        }

        let tokens = TokenStats(
            promptTokens: decoded.usage?.promptTokens ?? 0,
            completionTokens: decoded.usage?.completionTokens ?? 0
        )
        return ModelResponse(text: text, tokenStats: tokens)
    }

    public func listModels(connector: APIConnectorConfig?) async throws -> [APIModelDescriptor] {
        let (baseURL, apiKey) = try connectorMaterial(connector: connector)
        let endpoint = baseURL.appendingPathComponent("v1/models")
        var requestURL = authorizedRequest(url: endpoint, apiKey: apiKey)
        requestURL.httpMethod = "GET"

        let data = try await dataOrThrow(requestURL)
        let decoded = try JSONDecoder().decode(APIModelsResponse.self, from: data)
        return decoded.data.sorted { $0.id < $1.id }
    }

    public func listAccessibleChatModels(connector: APIConnectorConfig?) async throws -> [APIModelDescriptor] {
        let allModels = try await listModels(connector: connector)
        let candidates = allModels.filter { isLikelyChatModel($0.id) }
        var accessible: [APIModelDescriptor] = []

        for model in candidates {
            if try await canUseModelForChatCompletions(modelID: model.id, connector: connector) {
                accessible.append(model)
            }
        }

        return accessible.sorted { $0.id < $1.id }
    }

    private func connectorMaterial(connector: APIConnectorConfig?) throws -> (URL, String) {
        guard let connector else {
            throw ModelRouterError.missingAPIConnector
        }
        guard let apiKey = try APIKeyStore.loadOpenAIKey(), !apiKey.isEmpty else {
            throw ModelRouterError.missingAPIKey
        }
        guard let baseURL = URL(string: connector.baseURL) else {
            throw ModelRouterError.invalidBaseURL
        }
        return (baseURL, apiKey)
    }

    private func authorizedRequest(url: URL, apiKey: String) -> URLRequest {
        var request = URLRequest(url: url)
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        return request
    }

    private func dataOrThrow(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ModelRouterError.invalidResponse
        }
        guard 200..<300 ~= http.statusCode else {
            let body = String(data: data, encoding: .utf8) ?? "<non-text body>"
            throw ModelRouterError.httpError(http.statusCode, String(body.prefix(240)))
        }
        return data
    }

    private func isLikelyChatModel(_ id: String) -> Bool {
        let modelID = id.lowercased()

        let likelyPrefixes = ["gpt-", "o1", "o3", "o4", "codex-"]
        let excludedTokens = [
            "embedding", "audio", "transcribe", "whisper", "moderation", "realtime", "tts", "image"
        ]

        guard likelyPrefixes.contains(where: { modelID.hasPrefix($0) }) else {
            return false
        }
        if excludedTokens.contains(where: { modelID.contains($0) }) {
            return false
        }
        if modelID.contains(":") {
            return false
        }
        return true
    }

    private func canUseModelForChatCompletions(modelID: String, connector: APIConnectorConfig?) async throws -> Bool {
        let (baseURL, apiKey) = try connectorMaterial(connector: connector)
        let endpoint = baseURL.appendingPathComponent("v1/chat/completions")
        var requestURL = authorizedRequest(url: endpoint, apiKey: apiKey)
        requestURL.httpMethod = "POST"
        requestURL.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let payload = ChatCompletionsRequest(
            model: modelID,
            messages: [.init(role: "user", content: "ping")],
            maxTokens: 1
        )
        requestURL.httpBody = try JSONEncoder().encode(payload)

        do {
            _ = try await dataOrThrow(requestURL)
            return true
        } catch ModelRouterError.httpError(let code, _) where code == 400 || code == 401 || code == 403 || code == 404 {
            return false
        } catch {
            return false
        }
    }
}

private struct ChatCompletionsRequest: Codable {
    struct Message: Codable {
        let role: String
        let content: String
    }

    let model: String
    let messages: [Message]
    let maxTokens: Int?
    let temperature: Double?
    let topP: Double?

    init(model: String, messages: [Message], maxTokens: Int? = nil, temperature: Double? = nil, topP: Double? = nil) {
        self.model = model
        self.messages = messages
        self.maxTokens = maxTokens
        self.temperature = temperature
        self.topP = topP
    }

    enum CodingKeys: String, CodingKey {
        case model
        case messages
        case maxTokens = "max_tokens"
        case temperature
        case topP = "top_p"
    }
}

private struct ChatCompletionsResponse: Codable {
    struct Choice: Codable {
        struct Message: Codable {
            let content: String
        }

        let message: Message
    }

    struct Usage: Codable {
        let promptTokens: Int
        let completionTokens: Int

        enum CodingKeys: String, CodingKey {
            case promptTokens = "prompt_tokens"
            case completionTokens = "completion_tokens"
        }
    }

    let choices: [Choice]
    let usage: Usage?
}

private struct APIModelsResponse: Codable {
    let data: [APIModelDescriptor]
}
