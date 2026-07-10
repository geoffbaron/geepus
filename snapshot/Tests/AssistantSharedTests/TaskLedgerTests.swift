import XCTest
@testable import AssistantShared

final class TaskLedgerTests: XCTestCase {
    func testSQLiteInsertionsAndAuditTrail() async throws {
        let tempDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        
        let ledger = try TaskLedger(baseDirectory: tempDir)
        let runID = UUID()
        
        try await ledger.appendEvent(runID: runID, stage: "test stage", explanation: "Initial event")
        try await ledger.appendEvent(runID: runID, stage: "test stage 2", explanation: "Second event")
        
        let events = try await ledger.getEvents()
        XCTAssertEqual(events.count, 2)
        XCTAssertEqual(events[0].explanation, "Initial event")
        XCTAssertEqual(events[1].explanation, "Second event")
        
        // Invariant check: reconstruct state correctly
        XCTAssertNotEqual(events[0].hash, events[1].hash)
        XCTAssertEqual(events[0].hash, events[1].previousHash)
    }
    
    func testCrashResumeCheckpoints() async throws {
        let tempDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let runID = UUID()
        
        // Initial run block simulating a crash
        do {
            let ledger = try TaskLedger(baseDirectory: tempDir)
            let state = RunState(runID: runID, nextActionIndex: 5, checkpoints: [], isHalted: false)
            try await ledger.saveState(state)
        }
        
        // Resume block
        do {
            let ledger = try TaskLedger(baseDirectory: tempDir)
            let recovered = try await ledger.loadState(runID: runID)
            XCTAssertNotNil(recovered)
            XCTAssertEqual(recovered?.nextActionIndex, 5)
        }
    }
}
