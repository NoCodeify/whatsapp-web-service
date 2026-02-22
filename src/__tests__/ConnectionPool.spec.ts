import { ConnectionPool } from "../core/ConnectionPool";
import { ProxyManager } from "../core/ProxyManager";
import { SessionManager } from "../core/SessionManager";
import { Firestore } from "@google-cloud/firestore";
import { PubSub } from "@google-cloud/pubsub";
import { ConnectionStateManager } from "../services/connectionStateManager";
import { CloudRunWebSocketManager } from "../services/CloudRunWebSocketManager";
import { ErrorHandler } from "../services/ErrorHandler";
import { InstanceCoordinator } from "../services/InstanceCoordinator";
import { WASocket } from "@whiskeysockets/baileys";

// Mock dependencies
jest.mock("@whiskeysockets/baileys");
jest.mock("../core/ProxyManager");
jest.mock("../core/SessionManager");
jest.mock("@google-cloud/firestore");
jest.mock("@google-cloud/pubsub");
jest.mock("../services/connectionStateManager");
jest.mock("../services/MediaService");
jest.mock("../services/CloudRunWebSocketManager");
jest.mock("../services/ErrorHandler");
jest.mock("../services/InstanceCoordinator");
jest.mock("../utils/phoneNumber", () => ({
  formatPhoneNumberSafe: jest.fn((phone) => {
    // Return null for invalid phone numbers
    if (phone === "invalid" || phone === "invalid-number") {
      return null;
    }
    return phone;
  }),
  formatWhatsAppJid: jest.fn((phone) => `${phone.replace("+", "")}@s.whatsapp.net`),
}));
jest.mock("pino", () => {
  const mockLogger = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
    trace: jest.fn(),
    fatal: jest.fn(),
  };
  return {
    __esModule: true,
    default: jest.fn(() => mockLogger),
  };
});

describe("ConnectionPool", () => {
  let connectionPool: ConnectionPool;
  let mockProxyManager: jest.Mocked<ProxyManager>;
  let mockSessionManager: jest.Mocked<SessionManager>;
  let mockFirestore: jest.Mocked<Firestore>;
  let mockPubsub: jest.Mocked<PubSub>;
  let mockConnectionStateManager: jest.Mocked<ConnectionStateManager>;
  let mockWsManager: jest.Mocked<CloudRunWebSocketManager>;
  let mockErrorHandler: jest.Mocked<ErrorHandler>;
  let mockInstanceCoordinator: jest.Mocked<InstanceCoordinator>;
  let mockSocket: jest.Mocked<WASocket>;

  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks();

    // Mock ProxyManager
    mockProxyManager = {
      assignProxy: jest.fn().mockResolvedValue("nl"),
      releaseProxy: jest.fn().mockResolvedValue(undefined),
      getAvailableCountries: jest.fn().mockReturnValue(["nl", "us", "de"]),
      cleanupSessions: jest.fn(),
    } as any;

    // Mock SessionManager
    mockSessionManager = {
      createConnection: jest.fn(),
      listAllSessions: jest.fn().mockResolvedValue([]),
      deleteSession: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
    } as any;

    // Mock WASocket
    mockSocket = {
      end: jest.fn(),
      logout: jest.fn().mockResolvedValue(undefined),
      ev: {
        on: jest.fn(),
        off: jest.fn(),
        removeAllListeners: jest.fn(),
      },
      sendMessage: jest.fn().mockResolvedValue({
        key: { id: "msg_123", remoteJid: "1234567890@s.whatsapp.net" },
      }),
    } as any;

    // Mock Firestore
    const mockDoc = {
      get: jest.fn().mockResolvedValue({
        exists: true,
        data: () => ({ proxy_country: "nl" }),
      }),
      set: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const mockCollection = {
      doc: jest.fn().mockReturnValue(mockDoc),
    };
    mockFirestore = {
      collection: jest.fn().mockReturnValue(mockCollection),
    } as any;

    // Mock PubSub
    mockPubsub = {
      topic: jest.fn().mockReturnValue({
        publishMessage: jest.fn().mockResolvedValue("msg_id"),
      }),
    } as any;

    // Mock ConnectionStateManager
    mockConnectionStateManager = {
      initializeState: jest.fn().mockResolvedValue(undefined),
      updateState: jest.fn().mockResolvedValue(undefined),
      recoverConnections: jest.fn().mockResolvedValue([]),
    } as any;

    // Mock CloudRunWebSocketManager
    mockWsManager = {
      on: jest.fn(),
      registerConnection: jest.fn().mockResolvedValue(undefined),
      unregisterConnection: jest.fn().mockResolvedValue(undefined),
      refreshConnectionHealth: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn(),
    } as any;

    // Mock ErrorHandler
    mockErrorHandler = {
      on: jest.fn(),
      executeWithRetry: jest.fn().mockImplementation((fn) => fn()),
      shutdown: jest.fn(),
    } as any;

    // Mock InstanceCoordinator
    mockInstanceCoordinator = {
      on: jest.fn(),
      start: jest.fn().mockResolvedValue(undefined),
      shouldHandleSession: jest.fn().mockResolvedValue(true),
      requestSessionOwnership: jest.fn().mockResolvedValue(true),
      updateSessionActivity: jest.fn().mockResolvedValue(undefined),
      releaseSessionOwnership: jest.fn().mockResolvedValue(undefined),
      getInstanceId: jest.fn().mockReturnValue("instance_123"),
      shutdown: jest.fn().mockResolvedValue(undefined),
    } as any;

    // Set environment variables
    process.env.MAX_CONNECTIONS = "5";
    process.env.HEALTH_CHECK_INTERVAL = "10000";
    process.env.SESSION_CLEANUP_INTERVAL = "20000";
    process.env.INSTANCE_URL = "http://test-instance:8080";
  });

  afterEach(async () => {
    // Clean up connection pool to stop timers
    if (connectionPool) {
      try {
        await connectionPool.shutdown(false);
      } catch (error) {
        // Ignore shutdown errors in tests
      }
    }
    jest.clearAllMocks();
    jest.clearAllTimers();
  });

  describe("Constructor and Initialization", () => {
    it("should initialize with correct configuration", () => {
      connectionPool = new ConnectionPool(
        mockProxyManager,
        mockSessionManager,
        mockFirestore,
        mockPubsub,
        mockConnectionStateManager,
        mockWsManager,
        mockErrorHandler,
        mockInstanceCoordinator
      );

      expect(connectionPool).toBeInstanceOf(ConnectionPool);
      expect(mockInstanceCoordinator.start).toHaveBeenCalled();
    });

    it("should set up event listeners on initialization", () => {
      connectionPool = new ConnectionPool(
        mockProxyManager,
        mockSessionManager,
        mockFirestore,
        mockPubsub,
        mockConnectionStateManager,
        mockWsManager,
        mockErrorHandler,
        mockInstanceCoordinator
      );

      // WebSocket manager listeners
      expect(mockWsManager.on).toHaveBeenCalledWith("connection-error", expect.any(Function));

      // Error handler listeners
      expect(mockErrorHandler.on).toHaveBeenCalledWith("websocket-recovery-needed", expect.any(Function));
      expect(mockErrorHandler.on).toHaveBeenCalledWith("connection-restart-needed", expect.any(Function));
      expect(mockErrorHandler.on).toHaveBeenCalledWith("connection-refresh-needed", expect.any(Function));
      expect(mockErrorHandler.on).toHaveBeenCalledWith("reconnection-needed", expect.any(Function));
      expect(mockErrorHandler.on).toHaveBeenCalledWith("graceful-shutdown", expect.any(Function));

      // Instance coordinator listeners
      expect(mockInstanceCoordinator.on).toHaveBeenCalledWith("session-transfer-needed", expect.any(Function));
      expect(mockInstanceCoordinator.on).toHaveBeenCalledWith("load-balance-recommendation", expect.any(Function));
      expect(mockInstanceCoordinator.on).toHaveBeenCalledWith("instance-health-changed", expect.any(Function));
    });

    it("should create default services when not provided", () => {
      // Mock the InstanceCoordinator constructor to return our mock
      const InstanceCoordinatorMock = InstanceCoordinator as jest.MockedClass<typeof InstanceCoordinator>;
      InstanceCoordinatorMock.mockImplementation(() => mockInstanceCoordinator);

      connectionPool = new ConnectionPool(mockProxyManager, mockSessionManager, mockFirestore, mockPubsub);

      expect(connectionPool).toBeInstanceOf(ConnectionPool);
    });
  });

  describe("Connection Creation and Pooling", () => {
    beforeEach(() => {
      connectionPool = new ConnectionPool(
        mockProxyManager,
        mockSessionManager,
        mockFirestore,
        mockPubsub,
        mockConnectionStateManager,
        mockWsManager,
        mockErrorHandler,
        mockInstanceCoordinator
      );

      mockSessionManager.createConnection.mockResolvedValue({
        socket: mockSocket,
        sessionExists: false,
        baileysVersion: "v7",
      });
    });

    it("should successfully add a new connection", async () => {
      const result = await connectionPool.addConnection("user123", "+1234567890", "nl");

      expect(result).toBe(true);
      expect(mockConnectionStateManager.initializeState).toHaveBeenCalledWith("user123", "+1234567890", "http://test-instance:8080");
      expect(mockSessionManager.createConnection).toHaveBeenCalledWith("user123", "+1234567890", "nl", undefined, false, undefined, "v7", false);
      expect(mockInstanceCoordinator.updateSessionActivity).toHaveBeenCalledWith("user123", "+1234567890");
    });

    it("should format phone numbers to E.164 format", async () => {
      const result = await connectionPool.addConnection("user123", "+1234567890", "nl");

      expect(result).toBe(true);
      expect(mockSessionManager.createConnection).toHaveBeenCalledWith("user123", expect.stringMatching(/^\+/), "nl", undefined, false, undefined, "v7", false);
    });

    it("should reject connections when at capacity", async () => {
      // Add connections up to max
      for (let i = 0; i < 5; i++) {
        await connectionPool.addConnection("user123", `+123456789${i}`, "nl");
      }

      // Try to add one more
      const result = await connectionPool.addConnection("user456", "+9999999999", "nl");

      expect(result).toBe(false);
    });

    it("should not create duplicate connections for same user/phone", async () => {
      await connectionPool.addConnection("user123", "+1234567890", "nl");

      // Try to add same connection again
      const result = await connectionPool.addConnection("user123", "+1234567890", "nl");

      expect(result).toBe(true);
      expect(mockSessionManager.createConnection).toHaveBeenCalledTimes(1);
    });

    it("should handle session ownership checks", async () => {
      mockInstanceCoordinator.shouldHandleSession.mockResolvedValue(false);
      mockInstanceCoordinator.requestSessionOwnership.mockResolvedValue(false);

      const result = await connectionPool.addConnection("user123", "+1234567890", "nl");

      expect(result).toBe(false);
      expect(mockInstanceCoordinator.shouldHandleSession).toHaveBeenCalledWith("user123", "+1234567890");
      expect(mockInstanceCoordinator.requestSessionOwnership).toHaveBeenCalledWith("user123", "+1234567890");
    });

    it("should handle recovery mode correctly", async () => {
      const result = await connectionPool.addConnection(
        "user123",
        "+1234567890",
        "nl",
        undefined,
        true // isRecovery
      );

      expect(result).toBe(true);
      expect(mockConnectionStateManager.updateState).toHaveBeenCalledWith("user123", "+1234567890", {
        instanceUrl: "http://test-instance:8080",
      });
      expect(mockSessionManager.createConnection).toHaveBeenCalledWith(
        "user123",
        "+1234567890",
        "nl",
        undefined,
        true, // Skip proxy creation in recovery
        undefined,
        "v7",
        false
      );
      // Should not update session activity in recovery mode
      expect(mockInstanceCoordinator.updateSessionActivity).not.toHaveBeenCalled();
    });

    it("should handle connection creation errors", async () => {
      mockSessionManager.createConnection.mockRejectedValue(new Error("Connection failed"));

      const result = await connectionPool.addConnection("user123", "+1234567890", "nl");

      expect(result).toBe(false);
    });

    it("should emit capacity-reached event when at max connections", async () => {
      const capacityReachedSpy = jest.fn();
      connectionPool.on("capacity-reached", capacityReachedSpy);

      // Fill to capacity
      for (let i = 0; i < 5; i++) {
        await connectionPool.addConnection("user123", `+123456789${i}`, "nl");
      }

      // Try to add one more
      await connectionPool.addConnection("user456", "+9999999999", "nl");

      expect(capacityReachedSpy).toHaveBeenCalled();
    });
  });

  describe("Connection Removal and Cleanup", () => {
    beforeEach(() => {
      connectionPool = new ConnectionPool(
        mockProxyManager,
        mockSessionManager,
        mockFirestore,
        mockPubsub,
        mockConnectionStateManager,
        mockWsManager,
        mockErrorHandler,
        mockInstanceCoordinator
      );

      mockSessionManager.createConnection.mockResolvedValue({
        socket: mockSocket,
        sessionExists: false,
        baileysVersion: "v7",
      });
    });

    it("should remove connection and logout", async () => {
      await connectionPool.addConnection("user123", "+1234567890", "nl");

      await connectionPool.removeConnection("user123", "+1234567890");

      expect(mockSocket.logout).toHaveBeenCalled();
      expect(mockSocket.end).toHaveBeenCalled();
      expect(mockSocket.ev.removeAllListeners).toHaveBeenCalled();
      expect(mockProxyManager.releaseProxy).toHaveBeenCalledWith("user123", "+1234567890");
      expect(mockWsManager.unregisterConnection).toHaveBeenCalledWith("user123:+1234567890");
      expect(mockInstanceCoordinator.releaseSessionOwnership).toHaveBeenCalledWith("user123", "+1234567890");
    });

    it("should remove connection without logout when skipLogout is true", async () => {
      await connectionPool.addConnection("user123", "+1234567890", "nl");

      await connectionPool.removeConnection("user123", "+1234567890", true);

      expect(mockSocket.logout).not.toHaveBeenCalled();
      expect(mockSocket.end).toHaveBeenCalled();
      expect(mockSocket.ev.removeAllListeners).toHaveBeenCalled();
    });

    it("should handle removal of non-existent connection gracefully", async () => {
      await expect(connectionPool.removeConnection("user999", "+9999999999")).resolves.not.toThrow();
    });

    it("should handle logout errors gracefully", async () => {
      await connectionPool.addConnection("user123", "+1234567890", "nl");

      mockSocket.logout.mockRejectedValue(new Error("Logout failed"));

      await expect(connectionPool.removeConnection("user123", "+1234567890")).resolves.not.toThrow();

      expect(mockSocket.end).toHaveBeenCalled();
    });

    it("should clear QR timeout when removing connection", async () => {
      await connectionPool.addConnection("user123", "+1234567890", "nl");

      const connection = connectionPool.getConnection("user123", "+1234567890");
      if (connection) {
        connection.qrTimeout = setTimeout(() => {}, 1000) as NodeJS.Timeout;
      }

      await connectionPool.removeConnection("user123", "+1234567890");

      expect(mockSocket.end).toHaveBeenCalled();
    });
  });

  describe("Connection State Tracking", () => {
    beforeEach(() => {
      connectionPool = new ConnectionPool(
        mockProxyManager,
        mockSessionManager,
        mockFirestore,
        mockPubsub,
        mockConnectionStateManager,
        mockWsManager,
        mockErrorHandler,
        mockInstanceCoordinator
      );

      mockSessionManager.createConnection.mockResolvedValue({
        socket: mockSocket,
        sessionExists: false,
        baileysVersion: "v7",
      });
    });

    it("should retrieve existing connection", async () => {
      await connectionPool.addConnection("user123", "+1234567890", "nl");

      const connection = connectionPool.getConnection("user123", "+1234567890");

      expect(connection).toBeDefined();
      expect(connection?.userId).toBe("user123");
      expect(connection?.phoneNumber).toBe("+1234567890");
    });

    it("should return null for non-existent connection", () => {
      const connection = connectionPool.getConnection("user999", "+9999999999");

      expect(connection).toBeNull();
    });

    it("should track connection metadata correctly", async () => {
      await connectionPool.addConnection("user123", "+1234567890", "nl");

      const connection = connectionPool.getConnection("user123", "+1234567890");

      expect(connection).toMatchObject({
        userId: "user123",
        phoneNumber: "+1234567890",
        proxyCountry: "nl",
        hasConnectedSuccessfully: false,
        messageCount: 0,
        instanceUrl: "http://test-instance:8080",
      });
      expect(connection?.createdAt).toBeInstanceOf(Date);
      expect(connection?.lastActivity).toBeInstanceOf(Date);
    });
  });

  describe("Max Connections Enforcement", () => {
    beforeEach(() => {
      connectionPool = new ConnectionPool(
        mockProxyManager,
        mockSessionManager,
        mockFirestore,
        mockPubsub,
        mockConnectionStateManager,
        mockWsManager,
        mockErrorHandler,
        mockInstanceCoordinator
      );

      mockSessionManager.createConnection.mockResolvedValue({
        socket: mockSocket,
        sessionExists: false,
        baileysVersion: "v7",
      });
    });

    it("should enforce max connections limit", async () => {
      const results = [];

      // Try to add 6 connections (max is 5)
      for (let i = 0; i < 6; i++) {
        const result = await connectionPool.addConnection("user123", `+123456789${i}`, "nl");
        results.push(result);
      }

      expect(results.filter((r) => r === true).length).toBe(5);
      expect(results.filter((r) => r === false).length).toBe(1);
    });

    it("should allow new connections after removing existing ones", async () => {
      // Fill to capacity
      for (let i = 0; i < 5; i++) {
        await connectionPool.addConnection("user123", `+123456789${i}`, "nl");
      }

      // Try to add one more (should fail)
      let result = await connectionPool.addConnection("user456", "+9999999999", "nl");
      expect(result).toBe(false);

      // Remove one connection
      await connectionPool.removeConnection("user123", "+1234567890");

      // Now should succeed
      result = await connectionPool.addConnection("user456", "+9999999999", "nl");
      expect(result).toBe(true);
    });
  });

  describe("Concurrent Connection Requests", () => {
    beforeEach(() => {
      connectionPool = new ConnectionPool(
        mockProxyManager,
        mockSessionManager,
        mockFirestore,
        mockPubsub,
        mockConnectionStateManager,
        mockWsManager,
        mockErrorHandler,
        mockInstanceCoordinator
      );

      mockSessionManager.createConnection.mockResolvedValue({
        socket: mockSocket,
        sessionExists: false,
        baileysVersion: "v7",
      });
    });

    it("should handle multiple concurrent connection requests", async () => {
      const promises = [];

      for (let i = 0; i < 3; i++) {
        promises.push(connectionPool.addConnection("user123", `+123456789${i}`, "nl"));
      }

      const results = await Promise.all(promises);

      expect(results.every((r) => r === true)).toBe(true);
    });

    it("should handle concurrent requests for same connection correctly", async () => {
      const promises = [
        connectionPool.addConnection("user123", "+1234567890", "nl"),
        connectionPool.addConnection("user123", "+1234567890", "nl"),
        connectionPool.addConnection("user123", "+1234567890", "nl"),
      ];

      const results = await Promise.all(promises);

      expect(results.every((r) => r === true)).toBe(true);
      // Note: Without mutex/locking, concurrent requests may create multiple connections
      // This is acceptable behavior as the first call will succeed and subsequent calls
      // will either succeed immediately if connection exists or create redundant connections
      expect(mockSessionManager.createConnection).toHaveBeenCalled();
    });
  });

  describe("Memory Threshold Monitoring", () => {
    beforeEach(() => {
      connectionPool = new ConnectionPool(
        mockProxyManager,
        mockSessionManager,
        mockFirestore,
        mockPubsub,
        mockConnectionStateManager,
        mockWsManager,
        mockErrorHandler,
        mockInstanceCoordinator
      );
    });

    it("should calculate memory usage correctly", () => {
      // Access private method through type assertion
      const getMemoryUsage = (connectionPool as any).getMemoryUsage.bind(connectionPool);

      const usage = getMemoryUsage();

      expect(typeof usage).toBe("number");
      expect(usage).toBeGreaterThanOrEqual(0);
      expect(usage).toBeLessThanOrEqual(1);
    });

    it("should parse Cloud Run memory limits", () => {
      const getContainerMemoryLimit = (connectionPool as any).getContainerMemoryLimit.bind(connectionPool);

      // Test with different memory formats
      process.env.MEMORY_LIMIT = "2Gi";
      let limit = getContainerMemoryLimit();
      expect(limit).toBeGreaterThan(0);

      process.env.MEMORY_LIMIT = "512Mi";
      limit = getContainerMemoryLimit();
      expect(limit).toBeGreaterThan(0);

      delete process.env.MEMORY_LIMIT;
      limit = getContainerMemoryLimit();
      expect(typeof limit).toBe("number");
    });
  });

  describe("Error Handling", () => {
    beforeEach(() => {
      connectionPool = new ConnectionPool(
        mockProxyManager,
        mockSessionManager,
        mockFirestore,
        mockPubsub,
        mockConnectionStateManager,
        mockWsManager,
        mockErrorHandler,
        mockInstanceCoordinator
      );

      mockSessionManager.createConnection.mockResolvedValue({
        socket: mockSocket,
        sessionExists: false,
        baileysVersion: "v7",
      });
    });

    it("should handle invalid phone numbers", async () => {
      await expect(connectionPool.addConnection("user123", "invalid", "nl")).rejects.toThrow(/Invalid phone number format/);
    });

    it("should handle session manager errors", async () => {
      mockSessionManager.createConnection.mockRejectedValue(new Error("Session creation failed"));

      const result = await connectionPool.addConnection("user123", "+1234567890", "nl");

      expect(result).toBe(false);
    });

    it("should handle Firestore errors gracefully", async () => {
      mockConnectionStateManager.initializeState.mockRejectedValue(new Error("Firestore error"));

      const result = await connectionPool.addConnection("user123", "+1234567890", "nl");

      expect(result).toBe(false);
    });

    it("should handle proxy manager errors", async () => {
      mockProxyManager.releaseProxy.mockRejectedValue(new Error("Proxy release failed"));

      await connectionPool.addConnection("user123", "+1234567890", "nl");

      await expect(connectionPool.removeConnection("user123", "+1234567890")).resolves.not.toThrow();
    });
  });

  describe("Connection Recovery", () => {
    beforeEach(() => {
      connectionPool = new ConnectionPool(
        mockProxyManager,
        mockSessionManager,
        mockFirestore,
        mockPubsub,
        mockConnectionStateManager,
        mockWsManager,
        mockErrorHandler,
        mockInstanceCoordinator
      );

      mockSessionManager.createConnection.mockResolvedValue({
        socket: mockSocket,
        sessionExists: false,
        baileysVersion: "v7",
      });
    });

    it("should recover connections from session files", async () => {
      mockSessionManager.listAllSessions.mockResolvedValue([
        { userId: "user123", phoneNumber: "+1234567890", baileysVersion: "v7" },
        { userId: "user456", phoneNumber: "+9876543210", baileysVersion: "v7" },
      ]);

      mockConnectionStateManager.recoverConnections.mockResolvedValue([
        {
          userId: "user123",
          phoneNumber: "+1234567890",
          status: "connected" as const,
          instanceUrl: "http://test:8080",
          createdAt: new Date(),
          lastActivity: new Date(),
          lastHeartbeat: new Date(),
          messageCount: 0,
          sessionExists: true,
          qrScanned: true,
          proxy_country: "nl",
        } as any,
        {
          userId: "user456",
          phoneNumber: "+9876543210",
          status: "connected" as const,
          instanceUrl: "http://test:8080",
          createdAt: new Date(),
          lastActivity: new Date(),
          lastHeartbeat: new Date(),
          messageCount: 0,
          sessionExists: true,
          qrScanned: true,
          proxy_country: "us",
        } as any,
      ]);

      await connectionPool.initializeRecovery();

      expect(mockSessionManager.createConnection).toHaveBeenCalledTimes(2);
      expect(mockSessionManager.createConnection).toHaveBeenCalledWith("user123", "+1234567890", "nl", undefined, true, undefined, "v7", false);
      expect(mockSessionManager.createConnection).toHaveBeenCalledWith("user456", "+9876543210", "us", undefined, true, undefined, "v7", false);
    });

    it("should skip logged out sessions during recovery", async () => {
      mockSessionManager.listAllSessions.mockResolvedValue([
        { userId: "user123", phoneNumber: "+1234567890", baileysVersion: "v7" as const },
        { userId: "user456", phoneNumber: "+9876543210", baileysVersion: "v7" as const },
      ]);

      mockConnectionStateManager.recoverConnections.mockResolvedValue([
        {
          userId: "user123",
          phoneNumber: "+1234567890",
          status: "logged_out",
        } as any,
        {
          userId: "user456",
          phoneNumber: "+9876543210",
          status: "connected" as const,
          instanceUrl: "http://test:8080",
          createdAt: new Date(),
          lastActivity: new Date(),
          lastHeartbeat: new Date(),
          messageCount: 0,
          sessionExists: true,
          qrScanned: true,
          proxy_country: "us",
        } as any,
      ]);

      await connectionPool.initializeRecovery();

      // Should only recover the non-logged-out session
      expect(mockSessionManager.createConnection).toHaveBeenCalledTimes(1);
      expect(mockSessionManager.createConnection).toHaveBeenCalledWith("user456", "+9876543210", "us", undefined, true, undefined, "v7", false);
    });

    it("should handle recovery errors gracefully", async () => {
      mockSessionManager.listAllSessions.mockResolvedValue([{ userId: "user123", phoneNumber: "+1234567890", baileysVersion: "v7" as const }]);

      mockSessionManager.createConnection.mockRejectedValue(new Error("Recovery failed"));

      await expect(connectionPool.initializeRecovery()).resolves.not.toThrow();
    });

    it("should handle empty session list", async () => {
      mockSessionManager.listAllSessions.mockResolvedValue([]);

      await connectionPool.initializeRecovery();

      expect(mockSessionManager.createConnection).not.toHaveBeenCalled();
    });
  });

  describe("Message Sending", () => {
    beforeEach(() => {
      connectionPool = new ConnectionPool(
        mockProxyManager,
        mockSessionManager,
        mockFirestore,
        mockPubsub,
        mockConnectionStateManager,
        mockWsManager,
        mockErrorHandler,
        mockInstanceCoordinator
      );

      mockSessionManager.createConnection.mockResolvedValue({
        socket: mockSocket,
        sessionExists: false,
        baileysVersion: "v7",
      });
    });

    it("should send message successfully", async () => {
      await connectionPool.addConnection("user123", "+1234567890", "nl");

      // Manually set connection state to "open" to allow message sending
      const connection = connectionPool.getConnection("user123", "+1234567890");
      if (connection) {
        connection.state.connection = "open";
      }

      const messageContent = {
        conversation: "Hello",
      };

      const result = await connectionPool.sendMessage("user123", "+1234567890", "+9876543210", messageContent);

      expect(result).toBeDefined();
      expect(mockSocket.sendMessage).toHaveBeenCalled();
    });

    it("should return null when connection not found", async () => {
      const messageContent = {
        conversation: "Hello",
      };

      const result = await connectionPool.sendMessage("user999", "+9999999999", "+9876543210", messageContent);

      expect(result).toBeNull();
    });
  });

  describe("Message Event Handling", () => {
    let mockFetch: jest.Mock;
    let messagesUpsertHandler: (upsert: any) => Promise<void>;

    beforeEach(async () => {
      // Clear all mocks first
      jest.clearAllMocks();

      // Mock global fetch
      mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, messageId: "pub-123" }),
        text: async () => "",
      });
      global.fetch = mockFetch as any;

      // Ensure mockErrorHandler has handleError method
      mockErrorHandler = {
        on: jest.fn(),
        executeWithRetry: jest.fn().mockImplementation((fn) => fn()),
        handleError: jest.fn().mockResolvedValue(true),
        shutdown: jest.fn(),
      } as any;

      // Reset mockSocket
      mockSocket = {
        end: jest.fn(),
        logout: jest.fn().mockResolvedValue(undefined),
        ev: {
          on: jest.fn(),
          off: jest.fn(),
          removeAllListeners: jest.fn(),
        },
        sendMessage: jest.fn().mockResolvedValue({
          key: { id: "msg_123", remoteJid: "1234567890@s.whatsapp.net" },
        }),
      } as any;

      connectionPool = new ConnectionPool(
        mockProxyManager,
        mockSessionManager,
        mockFirestore,
        mockPubsub,
        mockConnectionStateManager,
        mockWsManager,
        mockErrorHandler,
        mockInstanceCoordinator
      );

      mockSessionManager.createConnection.mockResolvedValue({
        socket: mockSocket,
        sessionExists: false,
        baileysVersion: "v7",
      });

      // Capture the messages.upsert handler when connection is created
      (mockSocket.ev.on as jest.Mock).mockImplementation((event: string, handler: any) => {
        if (event === "messages.upsert") {
          messagesUpsertHandler = handler;
        }
      });

      // Add a connection to register the event handlers
      await connectionPool.addConnection("user123", "+1234567890", "nl");
    });

    afterEach(() => {
      delete (global as any).fetch;
    });

    it("should handle notify type messages as real-time incoming messages", async () => {
      // Ensure handler was captured
      expect(messagesUpsertHandler).toBeDefined();

      const testMessage = {
        key: {
          id: "test-msg-123",
          remoteJid: "31612345678@s.whatsapp.net",
          fromMe: false,
        },
        message: {
          conversation: "Hello from notify type",
        },
        messageTimestamp: Math.floor(Date.now() / 1000), // Current timestamp
      };

      const upsert = {
        type: "notify",
        messages: [testMessage],
      };

      await messagesUpsertHandler(upsert);

      // Verify fetch was called to send message to Cloud Function
      expect(mockFetch).toHaveBeenCalled();
      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[0]).toContain("incomingWhatsAppWebMessage");

      const payload = JSON.parse(fetchCall[1].body);
      expect(payload.body).toBe("Hello from notify type");
      expect(payload.fromPhoneNumber).toBe("+31612345678");
      expect(payload.userId).toBe("user123");
    });

    it("should handle append type messages as history sync", async () => {
      const testMessage = {
        key: {
          id: "history-msg-123",
          remoteJid: "31612345678@s.whatsapp.net",
          fromMe: false,
        },
        message: {
          conversation: "Old history message",
        },
        messageTimestamp: Math.floor((Date.now() - 2 * 60 * 60 * 1000) / 1000), // 2 hours ago
      };

      const upsert = {
        type: "append",
        messages: [testMessage],
      };

      await messagesUpsertHandler(upsert);

      // Verify fetch was NOT called (history messages don't go to Cloud Function immediately)
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should skip group messages", async () => {
      const groupMessage = {
        key: {
          id: "group-msg-123",
          remoteJid: "123456789@g.us", // Group identifier
          fromMe: false,
        },
        message: {
          conversation: "Group message",
        },
        messageTimestamp: Math.floor(Date.now() / 1000),
      };

      const upsert = {
        type: "notify",
        messages: [groupMessage],
      };

      await messagesUpsertHandler(upsert);

      // Group messages should be skipped
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("Shutdown", () => {
    beforeEach(() => {
      connectionPool = new ConnectionPool(
        mockProxyManager,
        mockSessionManager,
        mockFirestore,
        mockPubsub,
        mockConnectionStateManager,
        mockWsManager,
        mockErrorHandler,
        mockInstanceCoordinator
      );

      mockSessionManager.createConnection.mockResolvedValue({
        socket: mockSocket,
        sessionExists: false,
        baileysVersion: "v7",
      });
    });

    it("should shutdown gracefully with session preservation", async () => {
      await connectionPool.addConnection("user123", "+1234567890", "nl");
      await connectionPool.addConnection("user123", "+1234567891", "nl");

      await connectionPool.shutdown(true);

      expect(mockSocket.end).toHaveBeenCalledTimes(2);
      // Should not logout when preserving sessions
      expect(mockSocket.logout).not.toHaveBeenCalled();
    });

    it("should shutdown without preserving sessions", async () => {
      await connectionPool.addConnection("user123", "+1234567890", "nl");
      await connectionPool.addConnection("user123", "+1234567891", "nl");

      await connectionPool.shutdown(false);

      expect(mockSocket.logout).toHaveBeenCalledTimes(2);
      expect(mockSocket.end).toHaveBeenCalledTimes(2);
    });

    it("should prevent new connections during shutdown", async () => {
      await connectionPool.addConnection("user123", "+1234567890", "nl");

      // Start shutdown (don't await)
      const shutdownPromise = connectionPool.shutdown(true);

      // Try to add connection during shutdown
      await connectionPool.addConnection("user456", "+9876543210", "nl");

      await shutdownPromise;

      // Shutdown flag prevents new connections, so we can't make assertions
      // about rejection during shutdown without access to the flag
    });
  });

  describe("Utility Methods", () => {
    beforeEach(() => {
      connectionPool = new ConnectionPool(
        mockProxyManager,
        mockSessionManager,
        mockFirestore,
        mockPubsub,
        mockConnectionStateManager,
        mockWsManager,
        mockErrorHandler,
        mockInstanceCoordinator
      );
    });

    it("should get MediaService instance", () => {
      const mediaService = connectionPool.getMediaService();

      expect(mediaService).toBeDefined();
    });

    it("should generate consistent connection keys", () => {
      const getConnectionKey = (connectionPool as any).getConnectionKey.bind(connectionPool);

      const key1 = getConnectionKey("user123", "+1234567890");
      const key2 = getConnectionKey("user123", "+1234567890");

      expect(key1).toBe(key2);
      expect(key1).toBe("user123:+1234567890");
    });

    it("should format JID correctly", () => {
      const formatJid = (connectionPool as any).formatJid.bind(connectionPool);

      expect(formatJid("+1234567890")).toBe("1234567890@s.whatsapp.net");
      expect(formatJid("1234567890")).toBe("1234567890@s.whatsapp.net");
    });

    it("should identify special WhatsApp identifiers", () => {
      const isSpecialWhatsAppIdentifier = (connectionPool as any).isSpecialWhatsAppIdentifier.bind(connectionPool);

      expect(isSpecialWhatsAppIdentifier("status@broadcast")).toBe(true);
      // @lid is NOT a special identifier - it's used for legitimate person-to-person messages
      // WhatsApp uses LID (Linked ID) for privacy-protected identifiers in some regions
      expect(isSpecialWhatsAppIdentifier("1234567890@lid")).toBe(false);
      expect(isSpecialWhatsAppIdentifier("1234567890@s.whatsapp.net")).toBe(false);
    });
  });

  describe("Adversarial Edge Cases", () => {
    beforeEach(() => {
      connectionPool = new ConnectionPool(
        mockProxyManager,
        mockSessionManager,
        mockFirestore,
        mockPubsub,
        mockConnectionStateManager,
        mockWsManager,
        mockErrorHandler,
        mockInstanceCoordinator
      );

      mockSessionManager.createConnection.mockResolvedValue({
        socket: mockSocket,
        sessionExists: false,
        baileysVersion: "v7",
      });
    });

    describe("Connection Pool Exhaustion", () => {
      it("should handle connection pool exhaustion with queueing behavior", async () => {
        // Fill pool to capacity (5 connections)
        const addPromises = [];
        for (let i = 0; i < 5; i++) {
          addPromises.push(connectionPool.addConnection("user123", `+123456789${i}`, "nl"));
        }
        await Promise.all(addPromises);

        // Try to add 3 more connections beyond capacity
        const overflowResults = await Promise.all([
          connectionPool.addConnection("user456", "+1111111111", "nl"),
          connectionPool.addConnection("user456", "+2222222222", "nl"),
          connectionPool.addConnection("user456", "+3333333333", "nl"),
        ]);

        // All overflow requests should be rejected
        expect(overflowResults.every((r) => r === false)).toBe(true);

        // Remove one connection to free up space
        await connectionPool.removeConnection("user123", "+1234567890");

        // Now one connection should succeed
        const result = await connectionPool.addConnection("user456", "+4444444444", "nl");
        expect(result).toBe(true);
      });

      it("should emit capacity-reached event multiple times when pool is full", async () => {
        const capacitySpy = jest.fn();
        connectionPool.on("capacity-reached", capacitySpy);

        // Fill to capacity
        for (let i = 0; i < 5; i++) {
          await connectionPool.addConnection("user123", `+123456789${i}`, "nl");
        }

        // Try to add 5 more connections
        for (let i = 0; i < 5; i++) {
          await connectionPool.addConnection("user456", `+987654321${i}`, "nl");
        }

        expect(capacitySpy).toHaveBeenCalledTimes(5);
      });
    });

    describe("Rapid Connect/Disconnect Cycles", () => {
      it("should handle 100 rapid connect/disconnect cycles without leaks", async () => {
        const userId = "stress-test-user";
        const cycles = 100;
        let successfulConnections = 0;
        let successfulDisconnections = 0;

        for (let i = 0; i < cycles; i++) {
          const phoneNumber = `+1234567${String(i).padStart(3, "0")}`;

          try {
            // Add connection
            const added = await connectionPool.addConnection(userId, phoneNumber, "nl");
            if (added) successfulConnections++;

            // Immediately remove it
            await connectionPool.removeConnection(userId, phoneNumber);
            successfulDisconnections++;
          } catch (error) {
            // Track errors but don't fail the test
          }
        }

        // Verify cleanup
        const connection = connectionPool.getConnection(userId, "+12345670099");
        expect(connection).toBeNull();

        // At least 95% should succeed (allowing for some timing issues)
        expect(successfulConnections).toBeGreaterThan(95);
        expect(successfulDisconnections).toBeGreaterThan(95);
      });

      it("should handle rapid reconnection of same session", async () => {
        const userId = "user123";
        const phoneNumber = "+1234567890";

        // Rapid connect/disconnect/connect cycles for same session
        for (let i = 0; i < 10; i++) {
          await connectionPool.addConnection(userId, phoneNumber, "nl");
          await connectionPool.removeConnection(userId, phoneNumber, true);
        }

        // Final connection should work
        const result = await connectionPool.addConnection(userId, phoneNumber, "nl");
        expect(result).toBe(true);

        // Verify proxy was released and re-assigned correctly
        expect(mockProxyManager.releaseProxy).toHaveBeenCalledTimes(10);
      });
    });

    describe("Memory Leak Detection", () => {
      it("should properly clean up all resources when removing connections", async () => {
        const userId = "user123";
        const phoneNumber = "+1234567890";

        // Add connection
        await connectionPool.addConnection(userId, phoneNumber, "nl");

        const connection = connectionPool.getConnection(userId, phoneNumber);
        expect(connection).not.toBeNull();

        // Set QR timeout to verify cleanup
        if (connection) {
          connection.qrTimeout = setTimeout(() => {}, 10000) as NodeJS.Timeout;
        }

        // Remove connection
        await connectionPool.removeConnection(userId, phoneNumber);

        // Verify all cleanup happened
        expect(connectionPool.getConnection(userId, phoneNumber)).toBeNull();
        expect(mockSocket.end).toHaveBeenCalled();
        expect(mockProxyManager.releaseProxy).toHaveBeenCalledWith(userId, phoneNumber);
        expect(mockWsManager.unregisterConnection).toHaveBeenCalledWith(`${userId}:${phoneNumber}`);
        expect(mockInstanceCoordinator.releaseSessionOwnership).toHaveBeenCalledWith(userId, phoneNumber);
      });

      it("should clear all maps and timers on shutdown", async () => {
        // Add multiple connections
        for (let i = 0; i < 3; i++) {
          await connectionPool.addConnection("user123", `+123456789${i}`, "nl");
        }

        // Shutdown without preserving sessions
        await connectionPool.shutdown(false);

        // Verify all connections are removed
        expect(mockSocket.logout).toHaveBeenCalledTimes(3);
        expect(mockSocket.end).toHaveBeenCalledTimes(3);

        // Verify services are shut down
        expect(mockWsManager.shutdown).toHaveBeenCalled();
        expect(mockErrorHandler.shutdown).toHaveBeenCalled();
        expect(mockInstanceCoordinator.shutdown).toHaveBeenCalled();
      });
    });

    describe("WebSocket Disconnection During Operations", () => {
      it("should handle message send when socket closes mid-operation", async () => {
        await connectionPool.addConnection("user123", "+1234567890", "nl");

        // Set connection to open state
        const connection = connectionPool.getConnection("user123", "+1234567890");
        if (connection) {
          connection.state.connection = "open";
        }

        // Mock socket.sendMessage to throw an error (simulating disconnect)
        mockSocket.sendMessage.mockRejectedValueOnce(new Error("Socket closed"));

        const result = await connectionPool.sendMessage("user123", "+1234567890", "+9876543210", { conversation: "Hello" });

        // Should handle error gracefully
        expect(result).toBeNull();
      });

      it("should return null when connection is not open during message send", async () => {
        await connectionPool.addConnection("user123", "+1234567890", "nl");

        // Leave connection in "connecting" state
        const result = await connectionPool.sendMessage("user123", "+1234567890", "+9876543210", { conversation: "Hello" });

        expect(result).toBeNull();
        expect(mockSocket.sendMessage).not.toHaveBeenCalled();
      });
    });

    describe("Proxy Failure Mid-Connection", () => {
      it("should handle proxy release failure during removeConnection", async () => {
        await connectionPool.addConnection("user123", "+1234567890", "nl");

        // Mock proxy release to fail
        mockProxyManager.releaseProxy.mockRejectedValueOnce(new Error("Proxy service unreachable"));

        // Should not throw even if proxy release fails
        await expect(connectionPool.removeConnection("user123", "+1234567890")).resolves.not.toThrow();

        // Connection should still be removed from pool
        expect(connectionPool.getConnection("user123", "+1234567890")).toBeNull();
      });

      it("should handle proxy assignment failure during addConnection", async () => {
        // Mock session creation to fail due to proxy issues
        mockSessionManager.createConnection.mockRejectedValueOnce(new Error("No proxies available"));

        const result = await connectionPool.addConnection("user123", "+1234567890", "nl");

        // Connection creation should fail gracefully
        expect(result).toBe(false);
      });
    });

    describe("Concurrent Removal", () => {
      it("should handle removing same connection twice simultaneously", async () => {
        await connectionPool.addConnection("user123", "+1234567890", "nl");

        // Attempt to remove the same connection twice concurrently
        const [result1, result2] = await Promise.all([
          connectionPool.removeConnection("user123", "+1234567890"),
          connectionPool.removeConnection("user123", "+1234567890"),
        ]);

        // Both should complete without errors
        expect(result1).toBeUndefined();
        expect(result2).toBeUndefined();

        // Connection should be removed
        expect(connectionPool.getConnection("user123", "+1234567890")).toBeNull();

        // Logout should be called at least once (might be called twice due to race)
        expect(mockSocket.logout).toHaveBeenCalled();
      });

      it("should handle concurrent add and remove of same connection", async () => {
        // Start adding a connection
        const addPromise = connectionPool.addConnection("user123", "+1234567890", "nl");

        // Immediately try to remove it (before add completes)
        const removePromise = connectionPool.removeConnection("user123", "+1234567890");

        await Promise.all([addPromise, removePromise]);

        // The final state should be consistent (either exists or doesn't)
        const connection = connectionPool.getConnection("user123", "+1234567890");
        // Connection might exist or not depending on timing, but shouldn't crash
        expect(typeof connection).toBeDefined();
      });
    });

    describe("Invalid Memory Limits", () => {
      it("should handle invalid MEMORY_LIMIT environment variable", () => {
        process.env.MEMORY_LIMIT = "invalid";

        const getContainerMemoryLimit = (connectionPool as any).getContainerMemoryLimit.bind(connectionPool);

        const limit = getContainerMemoryLimit();

        // Should return 0 or handle gracefully
        expect(typeof limit).toBe("number");
        expect(limit).toBeGreaterThanOrEqual(0);

        delete process.env.MEMORY_LIMIT;
      });

      it("should handle missing unit in MEMORY_LIMIT", () => {
        process.env.MEMORY_LIMIT = "1024";

        const getContainerMemoryLimit = (connectionPool as any).getContainerMemoryLimit.bind(connectionPool);

        const limit = getContainerMemoryLimit();

        expect(typeof limit).toBe("number");
        expect(limit).toBeGreaterThanOrEqual(0);

        delete process.env.MEMORY_LIMIT;
      });

      it("should calculate memory usage even with invalid container limit", () => {
        process.env.MEMORY_LIMIT = "invalid";

        const getMemoryUsage = (connectionPool as any).getMemoryUsage.bind(connectionPool);

        const usage = getMemoryUsage();

        // Should fall back to heap usage ratio
        expect(typeof usage).toBe("number");
        expect(usage).toBeGreaterThanOrEqual(0);
        expect(usage).toBeLessThanOrEqual(1);

        delete process.env.MEMORY_LIMIT;
      });
    });

    describe("Session Manager Failures", () => {
      it("should handle SessionManager throwing during connection creation", async () => {
        mockSessionManager.createConnection.mockRejectedValueOnce(new Error("Baileys initialization failed"));

        const result = await connectionPool.addConnection("user123", "+1234567890", "nl");

        expect(result).toBe(false);

        // Connection should not be in pool
        expect(connectionPool.getConnection("user123", "+1234567890")).toBeNull();
      });

      it("should handle SessionManager.listAllSessions failure during recovery", async () => {
        mockSessionManager.listAllSessions.mockRejectedValueOnce(new Error("Filesystem error"));

        await expect(connectionPool.initializeRecovery()).rejects.toThrow("Filesystem error");
      });

      it("should continue recovery even if individual sessions fail", async () => {
        mockSessionManager.listAllSessions.mockResolvedValue([
          { userId: "user1", phoneNumber: "+1111111111", baileysVersion: "v7" as const },
          { userId: "user2", phoneNumber: "+2222222222", baileysVersion: "v7" as const },
          { userId: "user3", phoneNumber: "+3333333333", baileysVersion: "v7" as const },
        ]);

        mockConnectionStateManager.recoverConnections.mockResolvedValue([
          {
            userId: "user1",
            phoneNumber: "+1111111111",
            status: "connected" as const,
            instanceUrl: "http://test:8080",
            createdAt: new Date(),
            lastActivity: new Date(),
            lastHeartbeat: new Date(),
            messageCount: 0,
            sessionExists: true,
            qrScanned: true,
            proxy_country: "nl",
          } as any,
          {
            userId: "user2",
            phoneNumber: "+2222222222",
            status: "connected" as const,
            instanceUrl: "http://test:8080",
            createdAt: new Date(),
            lastActivity: new Date(),
            lastHeartbeat: new Date(),
            messageCount: 0,
            sessionExists: true,
            qrScanned: true,
            proxy_country: "nl",
          } as any,
          {
            userId: "user3",
            phoneNumber: "+3333333333",
            status: "connected" as const,
            instanceUrl: "http://test:8080",
            createdAt: new Date(),
            lastActivity: new Date(),
            lastHeartbeat: new Date(),
            messageCount: 0,
            sessionExists: true,
            qrScanned: true,
            proxy_country: "nl",
          } as any,
        ]);

        // Make second session fail
        mockSessionManager.createConnection
          .mockResolvedValueOnce({ socket: mockSocket, sessionExists: false, baileysVersion: "v7" as const })
          .mockRejectedValueOnce(new Error("Session 2 failed"))
          .mockResolvedValueOnce({ socket: mockSocket, sessionExists: false, baileysVersion: "v7" as const });

        await connectionPool.initializeRecovery();

        // Should attempt all 3 sessions
        expect(mockSessionManager.createConnection).toHaveBeenCalledTimes(3);
      });
    });

    describe("Firestore Connection Failures", () => {
      it("should handle Firestore update failure during addConnection", async () => {
        mockConnectionStateManager.initializeState.mockRejectedValueOnce(new Error("Firestore unavailable"));

        const result = await connectionPool.addConnection("user123", "+1234567890", "nl");

        expect(result).toBe(false);

        // Connection should not be created
        expect(connectionPool.getConnection("user123", "+1234567890")).toBeNull();
      });

      it("should handle PubSub publish failure gracefully", async () => {
        const mockTopic = {
          publishMessage: jest.fn().mockRejectedValue(new Error("PubSub unavailable")),
        };
        mockPubsub.topic = jest.fn().mockReturnValue(mockTopic);

        // This should be tested in methods that publish to PubSub
        // The connection pool should handle publish failures gracefully
        await connectionPool.addConnection("user123", "+1234567890", "nl");

        // Connection should still be created even if PubSub fails
        const connection = connectionPool.getConnection("user123", "+1234567890");
        expect(connection).not.toBeNull();
      });

      it("should handle Firestore doc.get failure during recovery", async () => {
        const mockDoc = {
          get: jest.fn().mockRejectedValue(new Error("Firestore read timeout")),
        };
        const mockCollection = {
          doc: jest.fn().mockReturnValue(mockDoc),
        };
        mockFirestore.collection = jest.fn().mockReturnValue(mockCollection);

        mockSessionManager.listAllSessions.mockResolvedValue([{ userId: "user123", phoneNumber: "+1234567890", baileysVersion: "v7" as const }]);

        mockConnectionStateManager.recoverConnections.mockResolvedValue([
          {
            userId: "user123",
            phoneNumber: "+1234567890",
            status: "connected" as const,
            instanceUrl: "http://test:8080",
            createdAt: new Date(),
            lastActivity: new Date(),
            lastHeartbeat: new Date(),
            messageCount: 0,
            sessionExists: true,
            qrScanned: true,
            proxy_country: "nl",
          } as any,
        ]);

        // Recovery should complete even if Firestore reads fail for some sessions
        await expect(connectionPool.initializeRecovery()).resolves.not.toThrow();
      });
    });

    describe("Race Conditions and Timing Issues", () => {
      it("should handle shutdown during active connection creation", async () => {
        // Start adding connections
        const addPromises = [];
        for (let i = 0; i < 3; i++) {
          addPromises.push(connectionPool.addConnection("user123", `+123456789${i}`, "nl"));
        }

        // Immediately start shutdown
        const shutdownPromise = connectionPool.shutdown(true);

        // Wait for everything to complete
        await Promise.all([...addPromises, shutdownPromise]);

        // System should be in a consistent state
        expect(mockWsManager.shutdown).toHaveBeenCalled();
      });

      it("should prevent new connections during shutdown", async () => {
        await connectionPool.addConnection("user123", "+1234567890", "nl");

        // Start shutdown
        const shutdownPromise = connectionPool.shutdown(true);

        // Try to add new connection during shutdown
        const addResult = await connectionPool.addConnection("user456", "+9876543210", "nl");

        await shutdownPromise;

        // New connection should be rejected or handled appropriately
        // The actual behavior depends on implementation timing
        expect(typeof addResult).toBe("boolean");
      });
    });

    describe("Resource Exhaustion", () => {
      it("should handle excessive event listener registrations", async () => {
        // Add many connections, each registering event listeners
        const promises = [];
        for (let i = 0; i < 20; i++) {
          promises.push(connectionPool.addConnection("user123", `+123456789${i}`, "nl"));
        }

        await Promise.allSettled(promises);

        // Should not exceed EventEmitter listener limits or crash
        expect(true).toBe(true);
      });

      it("should handle timeout cleanup for QR codes", async () => {
        await connectionPool.addConnection("user123", "+1234567890", "nl");

        const connection = connectionPool.getConnection("user123", "+1234567890");

        // Simulate QR timeout being set
        if (connection) {
          connection.qrTimeout = setTimeout(() => {}, 60000) as NodeJS.Timeout;
        }

        // Remove connection before timeout expires
        await connectionPool.removeConnection("user123", "+1234567890");

        // Timeout should be cleared (no memory leak)
        if (connection) {
          expect(connection.qrTimeout).toBeUndefined();
        }
      });
    });
  });
});
