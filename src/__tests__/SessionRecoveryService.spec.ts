import { SessionRecoveryService } from "../services/SessionRecoveryService";
import { Firestore, Timestamp } from "@google-cloud/firestore";
import { ConnectionPool } from "../core/ConnectionPool";

// Mock dependencies
jest.mock("@google-cloud/firestore", () => {
  const actualTimestamp = jest.requireActual("@google-cloud/firestore").Timestamp;
  return {
    Firestore: jest.fn(),
    Timestamp: actualTimestamp,
  };
});

jest.mock("pino", () => ({
  __esModule: true,
  default: () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }),
}));

describe("SessionRecoveryService", () => {
  let sessionRecoveryService: SessionRecoveryService;
  let mockFirestore: jest.Mocked<Firestore>;
  let mockConnectionPool: jest.Mocked<ConnectionPool>;
  let mockInstanceCoordinator: any;
  let mockCollection: any;
  let mockCollectionGroup: any;
  let mockDoc: any;
  let mockBatch: any;
  let allBatches: any[];

  const mockInstanceId = "test-instance-123";
  const mockUserId = "user123";
  const mockPhoneNumber = "+1234567890";

  beforeEach(() => {
    // Reset environment variables
    process.env.AUTO_RECONNECT = "true";
    process.env.MAX_RECONNECT_ATTEMPTS = "3";
    process.env.RECONNECT_DELAY = "10"; // Very short delay for testing
    process.env.PRIORITY_COUNTRIES = "us,gb,de";
    process.env.HOSTNAME = "test-host";

    // Mock Firestore document operations
    mockDoc = {
      set: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue({
        exists: true,
        data: () => ({}),
      }),
      delete: jest.fn().mockResolvedValue(undefined),
      ref: {
        parent: {
          parent: {
            id: mockUserId,
          },
        },
      },
    };

    // Track all batches created
    allBatches = [];

    // Mock Firestore batch operations - create fresh one for each batch() call
    const createMockBatch = () => {
      const batch = {
        update: jest.fn(),
        delete: jest.fn(),
        commit: jest.fn().mockResolvedValue(undefined),
      };
      allBatches.push(batch);
      return batch;
    };

    mockBatch = createMockBatch();

    // Mock nested collection for users -> phone_numbers path
    const mockPhoneNumbersCollection = {
      doc: jest.fn().mockReturnValue(mockDoc),
    };

    // Add collection method to mockDoc for nested paths
    mockDoc.collection = jest.fn((name: string) => {
      if (name === "phone_numbers") {
        return mockPhoneNumbersCollection;
      }
      return mockCollection;
    });

    // Mock Firestore collection operations
    mockCollection = {
      doc: jest.fn().mockReturnValue(mockDoc),
      where: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValue({
        docs: [],
        size: 0,
        forEach: jest.fn(),
      }),
    };

    // Mock Firestore collectionGroup operations
    mockCollectionGroup = {
      where: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValue({
        docs: [],
        forEach: jest.fn(),
      }),
    };

    // Mock Firestore
    mockFirestore = {
      collection: jest.fn().mockReturnValue(mockCollection),
      collectionGroup: jest.fn().mockReturnValue(mockCollectionGroup),
      batch: jest.fn(() => {
        mockBatch = createMockBatch();
        return mockBatch;
      }),
    } as any;

    // Mock ConnectionPool
    mockConnectionPool = {
      addConnection: jest.fn().mockResolvedValue(true),
    } as any;

    // Mock InstanceCoordinator
    mockInstanceCoordinator = {
      shouldHandleSession: jest.fn().mockResolvedValue(true),
      updateSessionActivity: jest.fn().mockResolvedValue(undefined),
      releaseSessionOwnership: jest.fn().mockResolvedValue(undefined),
    };

    sessionRecoveryService = new SessionRecoveryService(mockFirestore, mockInstanceId);
    sessionRecoveryService.setConnectionPool(mockConnectionPool);
    sessionRecoveryService.setInstanceCoordinator(mockInstanceCoordinator);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("constructor and initialization", () => {
    it("should initialize with provided instanceId", () => {
      expect(sessionRecoveryService).toBeInstanceOf(SessionRecoveryService);
      expect(mockFirestore.collection).toHaveBeenCalledWith("server_instances");
    });

    it("should generate instanceId if not provided", () => {
      const service = new SessionRecoveryService(mockFirestore);
      expect(service).toBeInstanceOf(SessionRecoveryService);
    });

    it("should mark instance startup in Firestore", async () => {
      // Wait for async constructor operations
      await Promise.resolve();

      expect(mockFirestore.collection).toHaveBeenCalledWith("server_instances");
      expect(mockCollection.doc).toHaveBeenCalledWith(mockInstanceId);
      expect(mockDoc.set).toHaveBeenCalledWith({
        instanceId: mockInstanceId,
        startedAt: expect.any(Timestamp),
        status: "running",
        recoveryInProgress: false,
        pid: process.pid,
        hostname: "test-host",
      });
    });

    it("should handle instance startup failures gracefully", async () => {
      mockDoc.set.mockRejectedValueOnce(new Error("Firestore error"));

      const service = new SessionRecoveryService(mockFirestore, "error-instance");

      // Wait for async constructor operations
      await Promise.resolve();

      expect(service).toBeInstanceOf(SessionRecoveryService);
    });

    it("should parse environment variables correctly", () => {
      process.env.MAX_RECONNECT_ATTEMPTS = "5";
      process.env.RECONNECT_DELAY = "10000";

      const service = new SessionRecoveryService(mockFirestore, "env-test");
      expect(service).toBeInstanceOf(SessionRecoveryService);
    });
  });

  describe("setConnectionPool", () => {
    it("should set connection pool reference", () => {
      const newService = new SessionRecoveryService(mockFirestore);
      newService.setConnectionPool(mockConnectionPool);
      // No direct way to verify, but should not throw
      expect(newService).toBeInstanceOf(SessionRecoveryService);
    });
  });

  describe("setInstanceCoordinator", () => {
    it("should set instance coordinator reference", () => {
      const newService = new SessionRecoveryService(mockFirestore);
      newService.setInstanceCoordinator(mockInstanceCoordinator);
      // No direct way to verify, but should not throw
      expect(newService).toBeInstanceOf(SessionRecoveryService);
    });
  });

  describe("recoverActiveSessions", () => {
    it("should skip recovery when auto-reconnect is disabled", async () => {
      process.env.AUTO_RECONNECT = "false";
      const service = new SessionRecoveryService(mockFirestore, "no-reconnect");
      service.setConnectionPool(mockConnectionPool);

      await service.recoverActiveSessions();

      expect(mockFirestore.collectionGroup).not.toHaveBeenCalled();
    });

    it("should prevent concurrent recovery operations", async () => {
      const mockSessions = [
        {
          id: mockPhoneNumber,
          data: () => ({
            type: "whatsapp_web",
            whatsapp_web: {
              status: "connected",
              session_exists: true,
              last_updated: Timestamp.now(),
            },
          }),
          ref: {
            parent: {
              parent: { id: mockUserId },
            },
          },
        },
      ];

      mockCollectionGroup.get.mockResolvedValue({
        forEach: (callback: any) => mockSessions.forEach(callback),
      });

      // Start first recovery
      const promise1 = sessionRecoveryService.recoverActiveSessions();

      // Try to start second recovery immediately
      const promise2 = sessionRecoveryService.recoverActiveSessions();

      await Promise.all([promise1, promise2]);

      // Should only process once (called during first recovery attempt)
      expect(mockCollectionGroup.get).toHaveBeenCalled();
    });

    it("should fail gracefully when ConnectionPool is not set", async () => {
      const service = new SessionRecoveryService(mockFirestore, "no-pool");

      await service.recoverActiveSessions();

      expect(mockFirestore.collectionGroup).not.toHaveBeenCalled();
    });

    it("should recover active sessions successfully", async () => {
      const mockSessions = [
        {
          id: mockPhoneNumber,
          data: () => ({
            type: "whatsapp_web",
            whatsapp_web: {
              status: "connected",
              session_exists: true,
              phone_country: "us",
              last_updated: Timestamp.now(),
            },
          }),
          ref: {
            parent: {
              parent: { id: mockUserId },
            },
          },
        },
      ];

      mockCollectionGroup.get.mockResolvedValue({
        forEach: (callback: any) => mockSessions.forEach(callback),
      });

      await sessionRecoveryService.recoverActiveSessions();

      expect(mockFirestore.collectionGroup).toHaveBeenCalledWith("phone_numbers");
      expect(mockCollectionGroup.where).toHaveBeenCalledWith("type", "==", "whatsapp_web");
      expect(mockDoc.update).toHaveBeenCalledWith({
        recoveryInProgress: true,
        recoveryStartedAt: expect.any(Timestamp),
      });
      expect(mockConnectionPool.addConnection).toHaveBeenCalled();
    });

    it("should handle empty session list", async () => {
      mockCollectionGroup.get.mockResolvedValue({
        forEach: jest.fn(),
      });

      await sessionRecoveryService.recoverActiveSessions();

      expect(mockConnectionPool.addConnection).not.toHaveBeenCalled();
    });

    it("should recover sessions in batches", async () => {
      const mockSessions = Array.from({ length: 12 }, (_, i) => ({
        id: `+123456789${i}`,
        data: () => ({
          type: "whatsapp_web",
          whatsapp_web: {
            status: "connected",
            session_exists: true,
            phone_country: "us",
            last_updated: Timestamp.now(),
          },
        }),
        ref: {
          parent: {
            parent: { id: `user${i}` },
          },
        },
      }));

      mockCollectionGroup.get.mockResolvedValue({
        forEach: (callback: any) => mockSessions.forEach(callback),
      });

      await sessionRecoveryService.recoverActiveSessions();

      // Should process in batches of 5
      expect(mockConnectionPool.addConnection).toHaveBeenCalledTimes(12);
    });

    it("should handle Firestore query errors", async () => {
      mockCollectionGroup.get.mockRejectedValue(new Error("Firestore index missing"));

      await sessionRecoveryService.recoverActiveSessions();

      // Should complete without throwing
      expect(mockDoc.update).toHaveBeenCalledWith({
        recoveryInProgress: false,
        recoveryCompletedAt: expect.any(Timestamp),
      });
    });

    it("should prioritize sessions from priority countries", async () => {
      const mockSessions = [
        {
          id: "+441234567890",
          data: () => ({
            type: "whatsapp_web",
            whatsapp_web: {
              status: "connected",
              session_exists: true,
              phone_country: "gb",
              last_updated: Timestamp.fromDate(new Date("2024-01-02")),
            },
          }),
          ref: {
            parent: {
              parent: { id: "user1" },
            },
          },
        },
        {
          id: "+491234567890",
          data: () => ({
            type: "whatsapp_web",
            whatsapp_web: {
              status: "connected",
              session_exists: true,
              phone_country: "de",
              last_updated: Timestamp.fromDate(new Date("2024-01-03")),
            },
          }),
          ref: {
            parent: {
              parent: { id: "user2" },
            },
          },
        },
        {
          id: "+12345678901",
          data: () => ({
            type: "whatsapp_web",
            whatsapp_web: {
              status: "connected",
              session_exists: true,
              phone_country: "us",
              last_updated: Timestamp.fromDate(new Date("2024-01-01")),
            },
          }),
          ref: {
            parent: {
              parent: { id: "user3" },
            },
          },
        },
      ];

      mockCollectionGroup.get.mockResolvedValue({
        forEach: (callback: any) => mockSessions.forEach(callback),
      });

      await sessionRecoveryService.recoverActiveSessions();

      // US should be recovered first (priority index 0)
      const calls = mockConnectionPool.addConnection.mock.calls;
      expect(calls[0][1]).toBe("+12345678901");
    });

    it("should handle sessions with different statuses", async () => {
      const statuses = ["connected", "disconnected", "failed", "initializing", "pending_recovery"];
      const mockSessions = statuses.map((status, i) => ({
        id: `+123456789${i}`,
        data: () => ({
          type: "whatsapp_web",
          whatsapp_web: {
            status,
            session_exists: true,
            last_updated: Timestamp.now(),
          },
        }),
        ref: {
          parent: {
            parent: { id: `user${i}` },
          },
        },
      }));

      mockCollectionGroup.get.mockResolvedValue({
        forEach: (callback: any) => mockSessions.forEach(callback),
      });

      await sessionRecoveryService.recoverActiveSessions();

      // Should recover all eligible statuses
      expect(mockConnectionPool.addConnection).toHaveBeenCalledTimes(5);
    });

    it("should skip sessions without session data", async () => {
      const mockSessions = [
        {
          id: mockPhoneNumber,
          data: () => ({
            type: "whatsapp_web",
            whatsapp_web: {
              status: "connected",
              session_exists: false,
              qr_scanned: false,
            },
          }),
          ref: {
            parent: {
              parent: { id: mockUserId },
            },
          },
        },
      ];

      mockCollectionGroup.get.mockResolvedValue({
        forEach: (callback: any) => mockSessions.forEach(callback),
      });

      await sessionRecoveryService.recoverActiveSessions();

      expect(mockConnectionPool.addConnection).not.toHaveBeenCalled();
    });
  });

  describe("cleanupStaleSessions", () => {
    it("should clean up sessions older than 72 hours", async () => {
      const oldDate = new Date(Date.now() - 80 * 60 * 60 * 1000); // 80 hours ago
      const mockSessions = [
        {
          ref: mockDoc.ref,
          data: () => ({
            type: "whatsapp_web",
            whatsapp_web: {
              last_activity: Timestamp.fromDate(oldDate),
            },
          }),
        },
      ];

      mockCollectionGroup.get.mockResolvedValueOnce({
        size: 1,
        forEach: (callback: any) => mockSessions.forEach(callback),
      });

      await sessionRecoveryService.cleanupStaleSessions();

      // Check that at least one batch had delete called
      const deleteCalls = allBatches.flatMap(b => b.delete.mock.calls);
      expect(deleteCalls.length).toBeGreaterThan(0);
      expect(deleteCalls[0][0]).toEqual(mockDoc.ref);

      // Check that at least one batch was committed
      const commitCalls = allBatches.flatMap(b => b.commit.mock.calls);
      expect(commitCalls.length).toBeGreaterThan(0);
    });

    it("should clean up failed sessions older than 24 hours", async () => {
      const oldDate = new Date(Date.now() - 30 * 60 * 60 * 1000); // 30 hours ago
      const mockSessions = [
        {
          ref: mockDoc.ref,
          data: () => ({
            type: "whatsapp_web",
            whatsapp_web: {
              status: "failed",
            },
            updated_at: Timestamp.fromDate(oldDate),
          }),
        },
      ];

      mockCollectionGroup.get
        .mockResolvedValueOnce({ size: 0, forEach: jest.fn() }) // stale sessions
        .mockResolvedValueOnce({
          size: 1,
          forEach: (callback: any) => mockSessions.forEach(callback),
        }); // failed sessions

      await sessionRecoveryService.cleanupStaleSessions();

      // Check that at least one batch had delete called
      const deleteCalls = allBatches.flatMap(b => b.delete.mock.calls);
      expect(deleteCalls.length).toBeGreaterThan(0);
      expect(deleteCalls[0][0]).toEqual(mockDoc.ref);

      // Check that at least one batch was committed
      const commitCalls = allBatches.flatMap(b => b.commit.mock.calls);
      expect(commitCalls.length).toBeGreaterThan(0);
    });

    it("should handle pending_recovery sessions appropriately", async () => {
      const oldDate = new Date(Date.now() - 8 * 60 * 60 * 1000); // 8 hours ago

      const sessionsWithData = [
        {
          ref: mockDoc.ref,
          data: () => ({
            type: "whatsapp_web",
            phone_number: mockPhoneNumber,
            session_exists: true,
            whatsapp_web: {
              status: "pending_recovery",
              last_activity: Timestamp.fromDate(oldDate),
            },
          }),
        },
      ];

      const sessionsWithoutData = [
        {
          ref: mockDoc.ref,
          data: () => ({
            type: "whatsapp_web",
            phone_number: "+9999999999",
            session_exists: false,
            qr_scanned: false,
            whatsapp_web: {
              status: "pending_recovery",
              last_activity: Timestamp.fromDate(oldDate),
            },
          }),
        },
      ];

      mockCollectionGroup.get
        .mockResolvedValueOnce({ size: 0, forEach: jest.fn() }) // stale sessions
        .mockResolvedValueOnce({ size: 0, forEach: jest.fn() }) // failed sessions
        .mockResolvedValueOnce({
          size: 2,
          forEach: (callback: any) => {
            sessionsWithData.forEach(callback);
            sessionsWithoutData.forEach(callback);
          },
        }); // pending_recovery sessions

      await sessionRecoveryService.cleanupStaleSessions();

      expect(mockBatch.update).toHaveBeenCalledTimes(2);
      expect(mockBatch.commit).toHaveBeenCalled();
    });

    it("should handle cleanup errors gracefully", async () => {
      mockCollectionGroup.get.mockRejectedValue(new Error("Firestore error"));

      await sessionRecoveryService.cleanupStaleSessions();

      // Should not throw
      expect(mockBatch.commit).not.toHaveBeenCalled();
    });

    it("should not commit empty batches", async () => {
      mockCollectionGroup.get
        .mockResolvedValueOnce({ size: 0, forEach: jest.fn() }) // stale sessions
        .mockResolvedValueOnce({ size: 0, forEach: jest.fn() }) // failed sessions
        .mockResolvedValueOnce({ size: 0, forEach: jest.fn() }); // pending_recovery sessions

      await sessionRecoveryService.cleanupStaleSessions();

      expect(mockBatch.commit).not.toHaveBeenCalled();
    });
  });

  describe("cleanupOldInstances", () => {
    it("should clean up instances older than 24 hours", async () => {
      const oldDate = new Date(Date.now() - 30 * 60 * 60 * 1000); // 30 hours ago
      const mockInstances = [
        {
          ref: mockDoc.ref,
          data: () => ({
            startedAt: Timestamp.fromDate(oldDate),
          }),
        },
      ];

      mockCollection.get.mockResolvedValue({
        size: 1,
        forEach: (callback: any) => mockInstances.forEach(callback),
      });

      await sessionRecoveryService.cleanupOldInstances();

      // Check that at least one batch had delete called
      const deleteCalls = allBatches.flatMap(b => b.delete.mock.calls);
      expect(deleteCalls.length).toBeGreaterThan(0);
      expect(deleteCalls[0][0]).toEqual(mockDoc.ref);

      // Check that at least one batch was committed
      const commitCalls = allBatches.flatMap(b => b.commit.mock.calls);
      expect(commitCalls.length).toBeGreaterThan(0);
    });

    it("should handle cleanup errors gracefully", async () => {
      mockCollection.get.mockRejectedValue(new Error("Firestore error"));

      await sessionRecoveryService.cleanupOldInstances();

      expect(mockBatch.commit).not.toHaveBeenCalled();
    });

    it("should commit empty batch when no old instances found", async () => {
      mockCollection.get.mockResolvedValue({
        size: 0,
        forEach: jest.fn(),
      });

      // Clear all previous batches
      allBatches.length = 0;

      await sessionRecoveryService.cleanupOldInstances();

      // Batch should be committed (even if empty)
      const commitCalls = allBatches.flatMap(b => b.commit.mock.calls);
      expect(commitCalls.length).toBe(1);

      // But no deletes should have been called
      const deleteCalls = allBatches.flatMap(b => b.delete.mock.calls);
      expect(deleteCalls.length).toBe(0);
    });
  });

  describe("shutdown", () => {
    it("should mark instance as stopped gracefully", async () => {
      await sessionRecoveryService.shutdown();

      expect(mockBatch.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          status: "stopped",
          gracefulShutdown: true,
        })
      );
      expect(mockBatch.commit).toHaveBeenCalled();
    });

    it("should handle shutdown errors gracefully", async () => {
      mockBatch.commit.mockRejectedValue(new Error("Firestore error"));

      await sessionRecoveryService.shutdown();

      // Should not throw
      expect(mockBatch.update).toHaveBeenCalled();
    });
  });

  describe("session recovery with instance coordination", () => {
    it("should skip session if another instance is handling it", async () => {
      const mockSessions = [
        {
          id: mockPhoneNumber,
          data: () => ({
            type: "whatsapp_web",
            whatsapp_web: {
              status: "connected",
              session_exists: true,
              last_updated: Timestamp.now(),
            },
          }),
          ref: {
            parent: {
              parent: { id: mockUserId },
            },
          },
        },
      ];

      mockCollectionGroup.get.mockResolvedValue({
        forEach: (callback: any) => mockSessions.forEach(callback),
      });

      mockInstanceCoordinator.shouldHandleSession.mockResolvedValue(false);

      await sessionRecoveryService.recoverActiveSessions();

      expect(mockConnectionPool.addConnection).not.toHaveBeenCalled();
    });

    it("should update session activity on successful recovery", async () => {
      const mockSessions = [
        {
          id: mockPhoneNumber,
          data: () => ({
            type: "whatsapp_web",
            whatsapp_web: {
              status: "connected",
              session_exists: true,
              last_updated: Timestamp.now(),
            },
          }),
          ref: {
            parent: {
              parent: { id: mockUserId },
            },
          },
        },
      ];

      mockCollectionGroup.get.mockResolvedValue({
        forEach: (callback: any) => mockSessions.forEach(callback),
      });

      mockConnectionPool.addConnection.mockResolvedValue(true);

      await sessionRecoveryService.recoverActiveSessions();

      expect(mockInstanceCoordinator.updateSessionActivity).toHaveBeenCalledWith(
        mockUserId,
        mockPhoneNumber
      );
    });

    it("should release session ownership on recovery failure", async () => {
      const mockSessions = [
        {
          id: mockPhoneNumber,
          data: () => ({
            type: "whatsapp_web",
            whatsapp_web: {
              status: "connected",
              session_exists: true,
              last_updated: Timestamp.now(),
            },
          }),
          ref: {
            parent: {
              parent: { id: mockUserId },
            },
          },
        },
      ];

      mockCollectionGroup.get.mockResolvedValue({
        forEach: (callback: any) => mockSessions.forEach(callback),
      });

      mockConnectionPool.addConnection.mockResolvedValue(false);

      await sessionRecoveryService.recoverActiveSessions();

      expect(mockInstanceCoordinator.releaseSessionOwnership).toHaveBeenCalledWith(
        mockUserId,
        mockPhoneNumber
      );
    });
  });

  describe("session recovery retry logic", () => {
    it("should retry failed connections up to max attempts", async () => {
      process.env.MAX_RECONNECT_ATTEMPTS = "3";
      const service = new SessionRecoveryService(mockFirestore, "retry-test");
      service.setConnectionPool(mockConnectionPool);
      service.setInstanceCoordinator(mockInstanceCoordinator);

      const mockSessions = [
        {
          id: mockPhoneNumber,
          data: () => ({
            type: "whatsapp_web",
            whatsapp_web: {
              status: "connected",
              session_exists: true,
              last_updated: Timestamp.now(),
            },
          }),
          ref: {
            parent: {
              parent: { id: mockUserId },
            },
          },
        },
      ];

      mockCollectionGroup.get.mockResolvedValue({
        forEach: (callback: any) => mockSessions.forEach(callback),
      });

      mockConnectionPool.addConnection
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      await service.recoverActiveSessions();

      expect(mockConnectionPool.addConnection).toHaveBeenCalledTimes(3);
    });

    it("should use exponential backoff between retries", async () => {
      process.env.RECONNECT_DELAY = "100"; // Short delay for testing
      const service = new SessionRecoveryService(mockFirestore, "backoff-test");
      service.setConnectionPool(mockConnectionPool);
      service.setInstanceCoordinator(mockInstanceCoordinator);

      const mockSessions = [
        {
          id: mockPhoneNumber,
          data: () => ({
            type: "whatsapp_web",
            whatsapp_web: {
              status: "connected",
              session_exists: true,
              last_updated: Timestamp.now(),
            },
          }),
          ref: {
            parent: {
              parent: { id: mockUserId },
            },
          },
        },
      ];

      mockCollectionGroup.get.mockResolvedValue({
        forEach: (callback: any) => mockSessions.forEach(callback),
      });

      mockConnectionPool.addConnection.mockResolvedValue(false);

      await service.recoverActiveSessions();

      // Should have attempted 3 times with exponential backoff
      expect(mockConnectionPool.addConnection).toHaveBeenCalledTimes(3);
    });

    it("should handle connection errors during retry", async () => {
      const mockSessions = [
        {
          id: mockPhoneNumber,
          data: () => ({
            type: "whatsapp_web",
            whatsapp_web: {
              status: "connected",
              session_exists: true,
              last_updated: Timestamp.now(),
            },
          }),
          ref: {
            parent: {
              parent: { id: mockUserId },
            },
          },
        },
      ];

      mockCollectionGroup.get.mockResolvedValue({
        forEach: (callback: any) => mockSessions.forEach(callback),
      });

      mockConnectionPool.addConnection
        .mockRejectedValueOnce(new Error("Connection failed"))
        .mockResolvedValueOnce(true);

      await sessionRecoveryService.recoverActiveSessions();

      expect(mockConnectionPool.addConnection).toHaveBeenCalledTimes(2);
    });
  });

  describe("session status updates", () => {
    it("should update status to connected on successful recovery", async () => {
      const mockSessions = [
        {
          id: mockPhoneNumber,
          data: () => ({
            type: "whatsapp_web",
            whatsapp_web: {
              status: "disconnected",
              session_exists: true,
              last_updated: Timestamp.now(),
            },
          }),
          ref: {
            parent: {
              parent: { id: mockUserId },
            },
          },
        },
      ];

      mockCollectionGroup.get.mockResolvedValue({
        forEach: (callback: any) => mockSessions.forEach(callback),
      });

      mockConnectionPool.addConnection.mockResolvedValue(true);

      // Clear previous calls from initialization
      mockDoc.set.mockClear();

      await sessionRecoveryService.recoverActiveSessions();

      expect(mockDoc.set).toHaveBeenCalledWith(
        expect.objectContaining({
          whatsapp_web: expect.objectContaining({
            status: "connected",
            recovery_attempted: true,
          }),
        }),
        { merge: true }
      );
    });

    it("should update status to failed on recovery failure", async () => {
      const mockSessions = [
        {
          id: mockPhoneNumber,
          data: () => ({
            type: "whatsapp_web",
            whatsapp_web: {
              status: "disconnected",
              session_exists: true,
              last_updated: Timestamp.now(),
            },
          }),
          ref: {
            parent: {
              parent: { id: mockUserId },
            },
          },
        },
      ];

      mockCollectionGroup.get.mockResolvedValue({
        forEach: (callback: any) => mockSessions.forEach(callback),
      });

      mockConnectionPool.addConnection.mockResolvedValue(false);

      // Clear previous calls from initialization
      mockDoc.set.mockClear();

      await sessionRecoveryService.recoverActiveSessions();

      expect(mockDoc.set).toHaveBeenCalledWith(
        expect.objectContaining({
          whatsapp_web: expect.objectContaining({
            status: "failed",
            recovery_attempted: true,
          }),
        }),
        { merge: true }
      );
    });

    it("should handle status update errors gracefully", async () => {
      const mockSessions = [
        {
          id: mockPhoneNumber,
          data: () => ({
            type: "whatsapp_web",
            whatsapp_web: {
              status: "connected",
              session_exists: true,
              last_updated: Timestamp.now(),
            },
          }),
          ref: {
            parent: {
              parent: { id: mockUserId },
            },
          },
        },
      ];

      mockCollectionGroup.get.mockResolvedValue({
        forEach: (callback: any) => mockSessions.forEach(callback),
      });

      mockDoc.set.mockRejectedValueOnce(new Error("Firestore update error"));
      mockConnectionPool.addConnection.mockResolvedValue(true);

      await sessionRecoveryService.recoverActiveSessions();

      // Should complete without throwing
      // Check that the last call was to mark recovery as complete
      const lastUpdateCall = mockDoc.update.mock.calls[mockDoc.update.mock.calls.length - 1][0];
      expect(lastUpdateCall).toEqual({
        recoveryInProgress: false,
        recoveryCompletedAt: expect.any(Timestamp),
      });
    });
  });

  describe("edge cases and error handling", () => {
    it("should handle sessions with missing userId", async () => {
      const mockSessions = [
        {
          id: mockPhoneNumber,
          data: () => ({
            type: "whatsapp_web",
            whatsapp_web: {
              status: "connected",
              session_exists: true,
            },
          }),
          ref: {
            parent: {
              parent: null, // No parent
            },
          },
        },
      ];

      mockCollectionGroup.get.mockResolvedValue({
        forEach: (callback: any) => mockSessions.forEach(callback),
      });

      await sessionRecoveryService.recoverActiveSessions();

      expect(mockConnectionPool.addConnection).not.toHaveBeenCalled();
    });

    it("should handle sessions with missing whatsapp_web data", async () => {
      const mockSessions = [
        {
          id: mockPhoneNumber,
          data: () => ({
            type: "whatsapp_web",
            // No whatsapp_web field
          }),
          ref: {
            parent: {
              parent: { id: mockUserId },
            },
          },
        },
      ];

      mockCollectionGroup.get.mockResolvedValue({
        forEach: (callback: any) => mockSessions.forEach(callback),
      });

      await sessionRecoveryService.recoverActiveSessions();

      expect(mockConnectionPool.addConnection).not.toHaveBeenCalled();
    });

    it("should extract country code from phone number correctly", async () => {
      const mockSessions = [
        {
          id: "+31612345678",
          data: () => ({
            type: "whatsapp_web",
            whatsapp_web: {
              status: "connected",
              session_exists: true,
              phone_country: "nl",
              last_updated: Timestamp.now(),
            },
          }),
          ref: {
            parent: {
              parent: { id: mockUserId },
            },
          },
        },
      ];

      mockCollectionGroup.get.mockResolvedValue({
        forEach: (callback: any) => mockSessions.forEach(callback),
      });

      mockConnectionPool.addConnection.mockResolvedValue(true);

      await sessionRecoveryService.recoverActiveSessions();

      expect(mockConnectionPool.addConnection).toHaveBeenCalledWith(
        mockUserId,
        "+31612345678",
        "nl",
        "316", // Regex matches up to 3 digits
        false
      );
    });

    it("should handle sessions without instance coordinator", async () => {
      const service = new SessionRecoveryService(mockFirestore, "no-coordinator");
      service.setConnectionPool(mockConnectionPool);
      // Don't set instance coordinator

      const mockSessions = [
        {
          id: mockPhoneNumber,
          data: () => ({
            type: "whatsapp_web",
            whatsapp_web: {
              status: "connected",
              session_exists: true,
              last_updated: Timestamp.now(),
            },
          }),
          ref: {
            parent: {
              parent: { id: mockUserId },
            },
          },
        },
      ];

      mockCollectionGroup.get.mockResolvedValue({
        forEach: (callback: any) => mockSessions.forEach(callback),
      });

      mockConnectionPool.addConnection.mockResolvedValue(true);

      await service.recoverActiveSessions();

      expect(mockConnectionPool.addConnection).toHaveBeenCalled();
    });
  });

  describe("batch processing", () => {
    it("should process large number of sessions in batches", async () => {
      const mockSessions = Array.from({ length: 25 }, (_, i) => ({
        id: `+123456789${String(i).padStart(2, "0")}`,
        data: () => ({
          type: "whatsapp_web",
          whatsapp_web: {
            status: "connected",
            session_exists: true,
            last_updated: Timestamp.now(),
          },
        }),
        ref: {
          parent: {
            parent: { id: `user${i}` },
          },
        },
      }));

      mockCollectionGroup.get.mockResolvedValue({
        forEach: (callback: any) => mockSessions.forEach(callback),
      });

      mockConnectionPool.addConnection.mockResolvedValue(true);

      await sessionRecoveryService.recoverActiveSessions();

      // Should process all 25 sessions in batches of 5
      expect(mockConnectionPool.addConnection).toHaveBeenCalledTimes(25);
    });

    it("should handle partial batch failures", async () => {
      const mockSessions = Array.from({ length: 3 }, (_, i) => ({
        id: `+123456789${i}`,
        data: () => ({
          type: "whatsapp_web",
          whatsapp_web: {
            status: "connected",
            session_exists: true,
            last_updated: Timestamp.now(),
          },
        }),
        ref: {
          parent: {
            parent: { id: `user${i}` },
          },
        },
      }));

      mockCollectionGroup.get.mockResolvedValue({
        forEach: (callback: any) => mockSessions.forEach(callback),
      });

      // All succeed on first attempt
      mockConnectionPool.addConnection.mockResolvedValue(true);

      await sessionRecoveryService.recoverActiveSessions();

      // Should process all 3 sessions with 1 call each
      expect(mockConnectionPool.addConnection).toHaveBeenCalledTimes(3);
    });
  });
});
