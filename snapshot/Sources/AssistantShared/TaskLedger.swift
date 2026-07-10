import Foundation
import SQLite3
import CryptoKit

public enum TaskLedgerError: Error {
    case dbError(String)
}

private final class SQLiteConnection: @unchecked Sendable {
    let raw: OpaquePointer?
    init(path: String) throws {
        var pointer: OpaquePointer?
        if sqlite3_open(path, &pointer) != SQLITE_OK {
            let msg = String(cString: sqlite3_errmsg(pointer))
            throw TaskLedgerError.dbError("Failed to open db: \(msg)")
        }
        self.raw = pointer
    }
    deinit {
        sqlite3_close(raw)
    }
}

public actor TaskLedger {
    private let connection: SQLiteConnection
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(baseDirectory: URL) throws {
        let dir = baseDirectory.appendingPathComponent("ledger", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dbURL = dir.appendingPathComponent("task_ledger.sqlite")
        
        self.connection = try SQLiteConnection(path: dbURL.path)
        
        encoder.dateEncodingStrategy = .iso8601
        decoder.dateDecodingStrategy = .iso8601
        
        let sql = """
        CREATE TABLE IF NOT EXISTS audit_events (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            stage TEXT NOT NULL,
            contract_data TEXT,
            decision_data TEXT,
            result_data TEXT,
            explanation TEXT NOT NULL,
            previous_hash TEXT NOT NULL,
            hash TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS run_states (
            run_id TEXT PRIMARY KEY,
            state_data TEXT NOT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS approvals (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            request_data TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        """
        var errMsg: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(connection.raw, sql, nil, nil, &errMsg) != SQLITE_OK {
            let msg = String(cString: errMsg!)
            sqlite3_free(errMsg)
            throw TaskLedgerError.dbError("Failed to create schema: \(msg)")
        }
    }
    

    public func appendEvent(
        runID: UUID,
        stage: String,
        contract: ExecutionContract? = nil,
        decision: PolicyDecision? = nil,
        result: ExecutionResult? = nil,
        explanation: String
    ) throws {
        let prev = try latestHash()
        
        struct CorePayload: Codable {
            let timestamp: Date
            let runID: UUID
            let stage: String
            let contract: ExecutionContract?
            let decision: PolicyDecision?
            let result: ExecutionResult?
            let explanation: String
            let previousHash: String
        }
        
        let payload = CorePayload(
            timestamp: Date(),
            runID: runID,
            stage: stage,
            contract: contract,
            decision: decision,
            result: result,
            explanation: explanation,
            previousHash: prev
        )
        let payloadData = try encoder.encode(payload)
        let hash = SHA256.hash(data: payloadData).compactMap { String(format: "%02x", $0) }.joined()
        
        let contractStr = contract != nil ? String(data: try encoder.encode(contract!), encoding: .utf8) : nil
        let decisionStr = decision != nil ? String(data: try encoder.encode(decision!), encoding: .utf8) : nil
        let resultStr = result != nil ? String(data: try encoder.encode(result!), encoding: .utf8) : nil
        
        let sql = "INSERT INTO audit_events (id, run_id, stage, contract_data, decision_data, result_data, explanation, previous_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);"
        var stmt: OpaquePointer?
        if sqlite3_prepare_v2(connection.raw, sql, -1, &stmt, nil) == SQLITE_OK {
            sqlite3_bind_text(stmt, 1, (UUID().uuidString as NSString).utf8String, -1, nil)
            sqlite3_bind_text(stmt, 2, (runID.uuidString as NSString).utf8String, -1, nil)
            sqlite3_bind_text(stmt, 3, (stage as NSString).utf8String, -1, nil)
            bindTextToStmt(stmt, 4, contractStr)
            bindTextToStmt(stmt, 5, decisionStr)
            bindTextToStmt(stmt, 6, resultStr)
            sqlite3_bind_text(stmt, 7, (explanation as NSString).utf8String, -1, nil)
            sqlite3_bind_text(stmt, 8, (prev as NSString).utf8String, -1, nil)
            sqlite3_bind_text(stmt, 9, (hash as NSString).utf8String, -1, nil)
            
            if sqlite3_step(stmt) != SQLITE_DONE {
                let msg = String(cString: sqlite3_errmsg(connection.raw))
                throw TaskLedgerError.dbError("Failed to insert audit event: \(msg)")
            }
        } else {
            let msg = String(cString: sqlite3_errmsg(connection.raw))
            throw TaskLedgerError.dbError("Failed to prepare audit insert: \(msg)")
        }
        sqlite3_finalize(stmt)
    }
    
    private func bindTextToStmt(_ stmt: OpaquePointer?, _ index: Int32, _ val: String?) {
        if let val = val {
            sqlite3_bind_text(stmt, index, (val as NSString).utf8String, -1, nil)
        } else {
            sqlite3_bind_null(stmt, index)
        }
    }
    
    private func latestHash() throws -> String {
        let sql = "SELECT hash FROM audit_events ORDER BY ROWID DESC LIMIT 1;"
        var stmt: OpaquePointer?
        var hash = "GENESIS"
        if sqlite3_prepare_v2(connection.raw, sql, -1, &stmt, nil) == SQLITE_OK {
            if sqlite3_step(stmt) == SQLITE_ROW {
                if let cStr = sqlite3_column_text(stmt, 0) {
                    hash = String(cString: cStr)
                }
            }
        }
        sqlite3_finalize(stmt)
        return hash
    }
    
    // Checkpoints & State (RunStateStore functionality)
    public func saveState(_ state: RunState) throws {
        let sql = "INSERT OR REPLACE INTO run_states (run_id, state_data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP);"
        var stmt: OpaquePointer?
        if sqlite3_prepare_v2(connection.raw, sql, -1, &stmt, nil) == SQLITE_OK {
            let dataStr = String(data: try encoder.encode(state), encoding: .utf8)!
            sqlite3_bind_text(stmt, 1, (state.runID.uuidString as NSString).utf8String, -1, nil)
            sqlite3_bind_text(stmt, 2, (dataStr as NSString).utf8String, -1, nil)
            
            if sqlite3_step(stmt) != SQLITE_DONE {
                throw TaskLedgerError.dbError("Failed to save run state")
            }
        }
        sqlite3_finalize(stmt)
    }
    
    public func loadState(runID: UUID) throws -> RunState? {
        let sql = "SELECT state_data FROM run_states WHERE run_id = ?;"
        var stmt: OpaquePointer?
        var state: RunState?
        if sqlite3_prepare_v2(connection.raw, sql, -1, &stmt, nil) == SQLITE_OK {
            sqlite3_bind_text(stmt, 1, (runID.uuidString as NSString).utf8String, -1, nil)
            if sqlite3_step(stmt) == SQLITE_ROW {
                if let dataStr = sqlite3_column_text(stmt, 0) {
                    let str = String(cString: dataStr)
                    state = try? decoder.decode(RunState.self, from: Data(str.utf8))
                }
            }
        }
        sqlite3_finalize(stmt)
        return state
    }
    
    // AI Wallet Approvals Inbox
    public func addApprovalRequest(runID: UUID, requestData: String) throws -> String {
        let id = UUID().uuidString
        let sql = "INSERT INTO approvals (id, run_id, request_data, status) VALUES (?, ?, ?, 'PENDING');"
        var stmt: OpaquePointer?
        if sqlite3_prepare_v2(connection.raw, sql, -1, &stmt, nil) == SQLITE_OK {
            sqlite3_bind_text(stmt, 1, (id as NSString).utf8String, -1, nil)
            sqlite3_bind_text(stmt, 2, (runID.uuidString as NSString).utf8String, -1, nil)
            sqlite3_bind_text(stmt, 3, (requestData as NSString).utf8String, -1, nil)
            
            if sqlite3_step(stmt) != SQLITE_DONE {
                throw TaskLedgerError.dbError("Failed to insert approval request")
            }
        }
        sqlite3_finalize(stmt)
        return id
    }
    
    public func updateApprovalStatus(id: String, status: String) throws {
        let sql = "UPDATE approvals SET status = ? WHERE id = ?;"
        var stmt: OpaquePointer?
        if sqlite3_prepare_v2(connection.raw, sql, -1, &stmt, nil) == SQLITE_OK {
            sqlite3_bind_text(stmt, 1, (status as NSString).utf8String, -1, nil)
            sqlite3_bind_text(stmt, 2, (id as NSString).utf8String, -1, nil)
            
            if sqlite3_step(stmt) != SQLITE_DONE {
                throw TaskLedgerError.dbError("Failed to update approval status")
            }
        }
        sqlite3_finalize(stmt)
    }

    public func getEvents() throws -> [AuditEntry] {
        let sql = "SELECT id, run_id, timestamp, stage, contract_data, decision_data, result_data, explanation, previous_hash, hash FROM audit_events ORDER BY ROWID ASC;"
        var stmt: OpaquePointer?
        var entries: [AuditEntry] = []
        
        let fallbackFormatter = DateFormatter()
        fallbackFormatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        fallbackFormatter.timeZone = TimeZone(secondsFromGMT: 0)
        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        
        if sqlite3_prepare_v2(connection.raw, sql, -1, &stmt, nil) == SQLITE_OK {
            while sqlite3_step(stmt) == SQLITE_ROW {
                let idStr = String(cString: sqlite3_column_text(stmt, 0))
                let runIDStr = String(cString: sqlite3_column_text(stmt, 1))
                let tsStr = String(cString: sqlite3_column_text(stmt, 2))
                let stage = String(cString: sqlite3_column_text(stmt, 3))
                
                let contractStr = sqlite3_column_text(stmt, 4).map { String(cString: $0) }
                let decisionStr = sqlite3_column_text(stmt, 5).map { String(cString: $0) }
                let resultStr = sqlite3_column_text(stmt, 6).map { String(cString: $0) }
                
                let explanation = String(cString: sqlite3_column_text(stmt, 7))
                let prevHash = String(cString: sqlite3_column_text(stmt, 8))
                let hash = String(cString: sqlite3_column_text(stmt, 9))
                
                let timestamp = fallbackFormatter.date(from: tsStr) ?? isoFormatter.date(from: tsStr) ?? Date()
                
                let contract = contractStr.flatMap { try? decoder.decode(ExecutionContract.self, from: Data($0.utf8)) }
                let decision = decisionStr.flatMap { try? decoder.decode(PolicyDecision.self, from: Data($0.utf8)) }
                let result = resultStr.flatMap { try? decoder.decode(ExecutionResult.self, from: Data($0.utf8)) }
                
                entries.append(AuditEntry(
                    id: UUID(uuidString: idStr) ?? UUID(),
                    timestamp: timestamp,
                    runID: UUID(uuidString: runIDStr) ?? UUID(),
                    stage: stage,
                    contract: contract,
                    decision: decision,
                    result: result,
                    explanation: explanation,
                    previousHash: prevHash,
                    hash: hash
                ))
            }
        }
        sqlite3_finalize(stmt)
        return entries
    }
}
