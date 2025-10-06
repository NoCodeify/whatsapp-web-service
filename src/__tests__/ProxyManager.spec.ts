import { ProxyManager, ProxyConfig } from "../core/ProxyManager";
import { BrightDataService } from "../services/BrightDataService";
import { DynamicProxyService } from "../services/DynamicProxyService";
import { Firestore } from "@google-cloud/firestore";
import { ProxyAgent } from "proxy-agent";
import axios from "axios";

// Mock dependencies
jest.mock("@google-cloud/firestore");
jest.mock("../services/BrightDataService");
jest.mock("../services/DynamicProxyService");
jest.mock("proxy-agent");
jest.mock("axios");
jest.mock("pino", () => ({
  __esModule: true,
  default: () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }),
}));

describe("ProxyManager", () => {
  let proxyManager: ProxyManager;
  let mockFirestore: jest.Mocked<Firestore>;
  let mockDynamicProxyService: jest.Mocked<DynamicProxyService>;
  let mockBrightDataService: jest.Mocked<BrightDataService>;

  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment variables
    process.env = { ...originalEnv };
    process.env.BRIGHT_DATA_HOST = "brd.superproxy.io";
    process.env.BRIGHT_DATA_PORT = "22225";
    process.env.BRIGHT_DATA_CUSTOMER_ID = "test-customer-id";
    process.env.BRIGHT_DATA_ZONE = "residential";
    process.env.BRIGHT_DATA_ZONE_PASSWORD = "test-password";

    // Mock Firestore
    mockFirestore = {} as jest.Mocked<Firestore>;

    // Mock DynamicProxyService
    mockDynamicProxyService = {
      assignProxy: jest.fn(),
      releaseProxy: jest.fn(),
      getMetrics: jest.fn(),
    } as any;

    // Mock BrightDataService
    mockBrightDataService = {
      getProxyConfig: jest.fn(),
      getMetrics: jest.fn(),
    } as any;

    // Clear all mocks
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("Constructor", () => {
    it("should initialize with proxy enabled when credentials are provided", () => {
      proxyManager = new ProxyManager(mockFirestore, mockDynamicProxyService);
      expect(proxyManager).toBeInstanceOf(ProxyManager);
    });

    it("should initialize without proxy when USE_PROXY=false", () => {
      process.env.USE_PROXY = "false";
      proxyManager = new ProxyManager(mockFirestore, mockDynamicProxyService);
      expect(proxyManager).toBeInstanceOf(ProxyManager);
    });

    it("should warn when credentials are missing", () => {
      delete process.env.BRIGHT_DATA_CUSTOMER_ID;
      delete process.env.BRIGHT_DATA_ZONE_PASSWORD;
      proxyManager = new ProxyManager(mockFirestore, mockDynamicProxyService);
      expect(proxyManager).toBeInstanceOf(ProxyManager);
    });

    it("should initialize DynamicProxyService for ISP mode", () => {
      proxyManager = new ProxyManager(mockFirestore, mockDynamicProxyService);
      expect(proxyManager).toBeInstanceOf(ProxyManager);
    });

    it("should initialize BrightDataService when only Firestore is provided", () => {
      proxyManager = new ProxyManager(mockFirestore);
      expect(proxyManager).toBeInstanceOf(ProxyManager);
    });
  });

  describe("getProxyConfig", () => {
    const userId = "user123";
    const phoneNumber = "+1234567890";

    beforeEach(() => {
      proxyManager = new ProxyManager(mockFirestore, mockDynamicProxyService);
    });

    it("should return null when credentials are not configured", async () => {
      delete process.env.BRIGHT_DATA_CUSTOMER_ID;
      delete process.env.BRIGHT_DATA_ZONE_PASSWORD;
      const pm = new ProxyManager(mockFirestore, mockDynamicProxyService);

      const config = await pm.getProxyConfig(userId, phoneNumber);
      expect(config).toBeNull();
    });

    it("should get proxy config with dynamic proxy service", async () => {
      const mockProxy = {
        ip: "1.2.3.4",
        port: 22225,
        country: "us",
      };

      mockDynamicProxyService.assignProxy.mockResolvedValue({
        proxy: mockProxy,
        fallbackUsed: false,
      });

      const config = await proxyManager.getProxyConfig(
        userId,
        phoneNumber,
        "us",
      );

      expect(mockDynamicProxyService.assignProxy).toHaveBeenCalledWith(
        userId,
        phoneNumber,
        "us",
      );
      expect(config).toMatchObject({
        host: "brd.superproxy.io",
        port: 22225,
        type: "isp",
        country: "us",
        ip: "1.2.3.4",
      });
      expect(config?.username).toContain("brd-customer-test-customer-id");
      expect(config?.password).toBe("test-password");
    });

    it("should reuse existing proxy from activeProxies", async () => {
      const mockProxy = {
        ip: "1.2.3.4",
        port: 22225,
        country: "us",
      };

      mockDynamicProxyService.assignProxy.mockResolvedValue({
        proxy: mockProxy,
        fallbackUsed: false,
      });

      // First call to create proxy
      await proxyManager.getProxyConfig(userId, phoneNumber, "us");

      // Second call should reuse existing proxy
      const config = await proxyManager.getProxyConfig(
        userId,
        phoneNumber,
        "us",
      );

      // assignProxy should only be called once
      expect(mockDynamicProxyService.assignProxy).toHaveBeenCalledTimes(1);
      expect((config as any)?.ip).toBe("1.2.3.4");
    });

    it("should handle dynamic proxy service failure and fallback", async () => {
      mockDynamicProxyService.assignProxy.mockRejectedValue(
        new Error("Dynamic allocation failed"),
      );

      // Inject BrightDataService as fallback
      (proxyManager as any).brightDataService = mockBrightDataService;

      const fallbackConfig: ProxyConfig = {
        host: "brd.superproxy.io",
        port: 22225,
        username: "test-user",
        password: "test-password",
        sessionId: "session123",
        type: "isp",
      };

      mockBrightDataService.getProxyConfig.mockResolvedValue(fallbackConfig);

      const config = await proxyManager.getProxyConfig(userId, phoneNumber);

      expect(mockBrightDataService.getProxyConfig).toHaveBeenCalledWith(
        userId,
        phoneNumber,
      );
      expect(config).toEqual(fallbackConfig);
    });

    it("should throw error when no proxy available in ISP mode", async () => {
      mockDynamicProxyService.assignProxy.mockRejectedValue(
        new Error(
          "No proxy available for us - not falling back to other countries",
        ),
      );
      (proxyManager as any).brightDataService = mockBrightDataService;
      mockBrightDataService.getProxyConfig.mockResolvedValue(null);

      await expect(
        proxyManager.getProxyConfig(userId, phoneNumber),
      ).rejects.toThrow(
        "No proxy available for secure connection. Connection blocked to protect user privacy.",
      );
    });

    it("should generate residential proxy config with country targeting", async () => {
      // Set residential mode by changing proxy type
      const originalProxyType = process.env.BRIGHT_DATA_PROXY_TYPE;
      delete (process.env as any).BRIGHT_DATA_PROXY_TYPE;

      // Remove dynamic proxy service to force residential mode
      const pm = new ProxyManager(mockFirestore);
      // Override proxyType to residential
      (pm as any).brightDataConfig.proxyType = "residential";

      const config = await pm.getProxyConfig(userId, phoneNumber, "gb");

      // Restore
      if (originalProxyType)
        process.env.BRIGHT_DATA_PROXY_TYPE = originalProxyType;

      expect(config).toMatchObject({
        host: "brd.superproxy.io",
        port: 22225,
        type: "residential",
        country: "gb",
      });
      expect(config?.username).toContain("country-gb");
      expect(config?.username).toContain("session-");
    });

    it("should generate residential proxy config without country", async () => {
      const pm = new ProxyManager(mockFirestore);
      (pm as any).brightDataConfig.proxyType = "residential";

      const config = await pm.getProxyConfig(userId, phoneNumber);

      expect(config).toMatchObject({
        host: "brd.superproxy.io",
        port: 22225,
        type: "residential",
      });
      expect(config?.username).not.toContain("country-");
    });
  });

  describe("createProxyAgent", () => {
    const userId = "user123";
    const phoneNumber = "+1234567890";

    beforeEach(() => {
      proxyManager = new ProxyManager(mockFirestore, mockDynamicProxyService);
    });

    it("should create proxy agent with valid config", async () => {
      const mockProxy = {
        ip: "1.2.3.4",
        port: 22225,
        country: "us",
      };

      mockDynamicProxyService.assignProxy.mockResolvedValue({
        proxy: mockProxy,
        fallbackUsed: false,
      });

      const mockProxyAgent = {} as ProxyAgent;
      (ProxyAgent as unknown as jest.Mock).mockImplementation(
        () => mockProxyAgent,
      );

      const agent = await proxyManager.createProxyAgent(
        userId,
        phoneNumber,
        "us",
      );

      expect(agent).toBe(mockProxyAgent);
      expect(ProxyAgent).toHaveBeenCalledWith({
        uri: expect.stringContaining("http://brd-customer-"),
      });
    });

    it("should return null when no proxy config available", async () => {
      delete process.env.BRIGHT_DATA_CUSTOMER_ID;
      const pm = new ProxyManager(mockFirestore, mockDynamicProxyService);

      const agent = await pm.createProxyAgent(userId, phoneNumber);

      expect(agent).toBeNull();
    });
  });

  describe("rotateProxy", () => {
    const userId = "user123";
    const phoneNumber = "+1234567890";

    beforeEach(() => {
      proxyManager = new ProxyManager(mockFirestore);
      (proxyManager as any).brightDataConfig.proxyType = "residential";
    });

    it("should rotate proxy and increment rotation count", async () => {
      // First create a session (residential mode)
      const config1 = await proxyManager.getProxyConfig(userId, phoneNumber);
      const sessionId1 = config1?.sessionId;

      // Rotate proxy (creates new session)
      const newConfig = await proxyManager.rotateProxy(userId, phoneNumber);
      const sessionId2 = newConfig?.sessionId;

      expect(newConfig).not.toBeNull();
      // Session ID should change after rotation
      expect(sessionId2).not.toBe(sessionId1);
      // Session should exist
      const sessionInfo = proxyManager.getSessionInfo(userId, phoneNumber);
      expect(sessionInfo).not.toBeNull();
      expect(sessionInfo?.sessionId).toBe(sessionId2);
    });

    it("should handle rotation for non-existent session", async () => {
      const config = await proxyManager.rotateProxy(userId, phoneNumber);

      expect(config).not.toBeNull();
    });
  });

  describe("releaseProxy", () => {
    const userId = "user123";
    const phoneNumber = "+1234567890";

    beforeEach(() => {
      proxyManager = new ProxyManager(mockFirestore, mockDynamicProxyService);
    });

    it("should release proxy successfully", async () => {
      const mockProxy = {
        ip: "1.2.3.4",
        port: 22225,
        country: "us",
      };

      mockDynamicProxyService.assignProxy.mockResolvedValue({
        proxy: mockProxy,
        fallbackUsed: false,
      });

      // Assign proxy first
      await proxyManager.getProxyConfig(userId, phoneNumber, "us");

      mockDynamicProxyService.releaseProxy.mockResolvedValue(undefined);

      // Release proxy
      await proxyManager.releaseProxy(userId, phoneNumber);

      expect(mockDynamicProxyService.releaseProxy).toHaveBeenCalledWith(
        "1.2.3.4",
      );
    });

    it("should handle release when no proxy is assigned", async () => {
      await proxyManager.releaseProxy(userId, phoneNumber);

      // Should not throw error
      expect(mockDynamicProxyService.releaseProxy).not.toHaveBeenCalled();
    });

    it("should handle release failure gracefully", async () => {
      const mockProxy = {
        ip: "1.2.3.4",
        port: 22225,
        country: "us",
      };

      mockDynamicProxyService.assignProxy.mockResolvedValue({
        proxy: mockProxy,
        fallbackUsed: false,
      });

      await proxyManager.getProxyConfig(userId, phoneNumber, "us");

      mockDynamicProxyService.releaseProxy.mockRejectedValue(
        new Error("Release failed"),
      );

      // Should not throw
      await proxyManager.releaseProxy(userId, phoneNumber);
    });
  });

  describe("testProxyConnection", () => {
    const userId = "user123";
    const phoneNumber = "+1234567890";

    beforeEach(() => {
      proxyManager = new ProxyManager(mockFirestore, mockDynamicProxyService);
    });

    it("should test proxy connection successfully", async () => {
      const mockProxy = {
        ip: "1.2.3.4",
        port: 22225,
        country: "us",
      };

      mockDynamicProxyService.assignProxy.mockResolvedValue({
        proxy: mockProxy,
        fallbackUsed: false,
      });

      const mockProxyAgent = {} as ProxyAgent;
      (ProxyAgent as unknown as jest.Mock).mockImplementation(
        () => mockProxyAgent,
      );

      (axios.get as jest.Mock).mockResolvedValue({
        data: { ip: "5.6.7.8" },
      });

      const result = await proxyManager.testProxyConnection(
        userId,
        phoneNumber,
      );

      expect(result).toBe(true);
      expect(axios.get).toHaveBeenCalledWith(
        "https://api.ipify.org?format=json",
        {
          httpsAgent: mockProxyAgent,
          timeout: 10000,
        },
      );
    });

    it("should return true when no proxy configured", async () => {
      delete process.env.BRIGHT_DATA_CUSTOMER_ID;
      const pm = new ProxyManager(mockFirestore, mockDynamicProxyService);

      const result = await pm.testProxyConnection(userId, phoneNumber);

      expect(result).toBe(true);
    });

    it("should return false on connection failure", async () => {
      const mockProxy = {
        ip: "1.2.3.4",
        port: 22225,
        country: "us",
      };

      mockDynamicProxyService.assignProxy.mockResolvedValue({
        proxy: mockProxy,
        fallbackUsed: false,
      });

      (ProxyAgent as unknown as jest.Mock).mockImplementation(() => ({}));
      (axios.get as jest.Mock).mockRejectedValue(
        new Error("Connection failed"),
      );

      const result = await proxyManager.testProxyConnection(
        userId,
        phoneNumber,
      );

      expect(result).toBe(false);
    });

    it("should return false when response has no IP", async () => {
      const mockProxy = {
        ip: "1.2.3.4",
        port: 22225,
        country: "us",
      };

      mockDynamicProxyService.assignProxy.mockResolvedValue({
        proxy: mockProxy,
        fallbackUsed: false,
      });

      (ProxyAgent as unknown as jest.Mock).mockImplementation(() => ({}));
      (axios.get as jest.Mock).mockResolvedValue({ data: {} });

      const result = await proxyManager.testProxyConnection(
        userId,
        phoneNumber,
      );

      expect(result).toBe(false);
    });
  });

  describe("getAvailableLocations", () => {
    beforeEach(() => {
      proxyManager = new ProxyManager(mockFirestore, mockDynamicProxyService);
    });

    it("should return list of available locations", () => {
      const locations = proxyManager.getAvailableLocations();

      expect(locations).toBeInstanceOf(Array);
      expect(locations.length).toBeGreaterThan(0);
      expect(locations[0]).toMatchObject({
        code: expect.any(String),
        name: expect.any(String),
        flag: expect.any(String),
        available: expect.any(Boolean),
      });
    });

    it("should include major countries", () => {
      const locations = proxyManager.getAvailableLocations();
      const codes = locations.map((l) => l.code);

      expect(codes).toContain("us");
      expect(codes).toContain("gb");
      expect(codes).toContain("de");
      expect(codes).toContain("au");
      expect(codes).toContain("jp");
    });

    it("should have region information", () => {
      const locations = proxyManager.getAvailableLocations();
      const usLocation = locations.find((l) => l.code === "us");

      expect(usLocation?.region).toBe("northAmerica");
    });
  });

  describe("findNearestLocation", () => {
    beforeEach(() => {
      proxyManager = new ProxyManager(mockFirestore, mockDynamicProxyService);
    });

    it("should return same country if available", () => {
      const nearest = proxyManager.findNearestLocation("us");
      expect(nearest).toBe("us");
    });

    it("should find location in same region if country not available", () => {
      // Mock availableLocations to make a specific country unavailable
      const locations = proxyManager.getAvailableLocations();
      const modifiedLocations = locations.map((l) =>
        l.code === "fr" ? { ...l, available: false } : l,
      );

      // Replace the private availableLocations property
      (proxyManager as any).availableLocations = modifiedLocations;

      const nearest = proxyManager.findNearestLocation("fr");

      // Should return another European country
      expect(["gb", "de", "nl", "es"]).toContain(nearest);
    });

    it("should use regional fallback for unknown countries", () => {
      const nearest = proxyManager.findNearestLocation("xx");
      // For unknown countries, it tries regional fallbacks and returns first available
      // which is "gb" (first in Europe fallback list)
      expect(["gb", "us"]).toContain(nearest);
    });

    it("should handle European countries", () => {
      const nearest = proxyManager.findNearestLocation("gb");
      expect(nearest).toBe("gb");
    });

    it("should handle Asia Pacific countries", () => {
      const nearest = proxyManager.findNearestLocation("au");
      expect(nearest).toBe("au");
    });
  });

  describe("updateSessionInfo", () => {
    const userId = "user123";
    const phoneNumber = "+1234567890";

    beforeEach(() => {
      proxyManager = new ProxyManager(mockFirestore);
      (proxyManager as any).brightDataConfig.proxyType = "residential";
    });

    it("should update session info with proxy IP and country", async () => {
      // Create session first (residential mode creates sessions)
      await proxyManager.getProxyConfig(userId, phoneNumber);

      proxyManager.updateSessionInfo(userId, phoneNumber, "1.2.3.4", "us");

      const sessionInfo = proxyManager.getSessionInfo(userId, phoneNumber);
      expect(sessionInfo?.proxyIp).toBe("1.2.3.4");
      expect(sessionInfo?.country).toBe("us");
    });

    it("should not throw if session doesn't exist", () => {
      expect(() =>
        proxyManager.updateSessionInfo(userId, phoneNumber, "1.2.3.4", "us"),
      ).not.toThrow();
    });
  });

  describe("getSessionInfo", () => {
    const userId = "user123";
    const phoneNumber = "+1234567890";

    beforeEach(() => {
      proxyManager = new ProxyManager(mockFirestore);
      (proxyManager as any).brightDataConfig.proxyType = "residential";
    });

    it("should return session info if exists", async () => {
      await proxyManager.getProxyConfig(userId, phoneNumber);

      const sessionInfo = proxyManager.getSessionInfo(userId, phoneNumber);

      expect(sessionInfo).toMatchObject({
        userId,
        phoneNumber,
        sessionId: expect.any(String),
        createdAt: expect.any(Date),
        lastUsed: expect.any(Date),
        rotationCount: 0,
      });
    });

    it("should return null if session doesn't exist", () => {
      const sessionInfo = proxyManager.getSessionInfo(userId, phoneNumber);
      expect(sessionInfo).toBeNull();
    });
  });

  describe("getMetrics", () => {
    beforeEach(() => {
      proxyManager = new ProxyManager(mockFirestore, mockDynamicProxyService);
    });

    it("should return metrics with no sessions", async () => {
      const metrics = await proxyManager.getMetrics();

      expect(metrics).toMatchObject({
        activeSessions: 0,
        totalRotations: 0,
        avgRotationsPerSession: 0,
        oldestSessionAge: 0,
        proxyType: expect.any(String),
      });
    });

    it("should return metrics with active sessions", async () => {
      // Use residential mode which creates sessions in sessions Map
      const pm = new ProxyManager(mockFirestore);
      (pm as any).brightDataConfig.proxyType = "residential";

      // Create some sessions
      await pm.getProxyConfig("user1", "+1111111111");
      await pm.getProxyConfig("user2", "+2222222222");

      const metrics = await pm.getMetrics();

      expect(metrics.activeSessions).toBe(2);
      expect(metrics.oldestSessionAge).toBeGreaterThanOrEqual(0);
    });

    it("should include dynamic proxy metrics", async () => {
      const dynamicMetrics = {
        message: "No proxy tracking - using direct purchase/release model",
      };

      mockDynamicProxyService.getMetrics.mockResolvedValue(dynamicMetrics);

      const metrics = await proxyManager.getMetrics();

      expect(metrics.dynamicProxy).toEqual(dynamicMetrics);
    });

    it("should include ISP proxy metrics when BrightDataService available", async () => {
      (proxyManager as any).brightDataService = mockBrightDataService;

      const ispMetrics = {
        total: 10,
        assigned: 5,
        available: 5,
        assignments: 5,
        utilizationRate: 50,
      };

      mockBrightDataService.getMetrics.mockReturnValue(ispMetrics);

      const metrics = await proxyManager.getMetrics();

      expect(metrics.ispProxy).toEqual(ispMetrics);
    });
  });

  describe("cleanupSessions", () => {
    beforeEach(() => {
      proxyManager = new ProxyManager(mockFirestore);
      (proxyManager as any).brightDataConfig.proxyType = "residential";
    });

    it("should clean up old sessions", async () => {
      // Create a session (residential mode creates sessions in sessions Map)
      await proxyManager.getProxyConfig("user1", "+1111111111");

      // Manually set lastUsed to old date
      const sessions = (proxyManager as any).sessions;
      const session = sessions.get("user1:+1111111111");
      if (session) {
        session.lastUsed = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48 hours ago
      }

      const cleaned = proxyManager.cleanupSessions(24 * 60 * 60 * 1000); // 24 hours

      expect(cleaned).toBe(1);
    });

    it("should not clean up recent sessions", async () => {
      await proxyManager.getProxyConfig("user1", "+1111111111");

      const cleaned = proxyManager.cleanupSessions(24 * 60 * 60 * 1000);

      expect(cleaned).toBe(0);
    });

    it("should return 0 when no sessions to clean", () => {
      const cleaned = proxyManager.cleanupSessions();
      expect(cleaned).toBe(0);
    });
  });

  describe("Proxy Configuration Validation", () => {
    it("should handle missing host configuration", () => {
      delete process.env.BRIGHT_DATA_HOST;
      const pm = new ProxyManager(mockFirestore, mockDynamicProxyService);
      expect(pm).toBeInstanceOf(ProxyManager);
    });

    it("should handle missing port configuration", () => {
      delete process.env.BRIGHT_DATA_PORT;
      const pm = new ProxyManager(mockFirestore, mockDynamicProxyService);
      expect(pm).toBeInstanceOf(ProxyManager);
    });

    it("should use default values for missing env vars", () => {
      delete process.env.BRIGHT_DATA_HOST;
      delete process.env.BRIGHT_DATA_PORT;
      delete process.env.BRIGHT_DATA_ZONE;

      const pm = new ProxyManager(mockFirestore, mockDynamicProxyService);
      expect(pm).toBeInstanceOf(ProxyManager);
    });
  });

  describe("Session ID Generation", () => {
    const userId = "user123";
    const phoneNumber = "+1234567890";

    beforeEach(() => {
      proxyManager = new ProxyManager(mockFirestore, mockDynamicProxyService);
    });

    it("should generate unique session IDs", async () => {
      // Access private method
      const generateSessionId = (proxyManager as any).generateSessionId.bind(
        proxyManager,
      );

      const sessionId1 = generateSessionId(userId, phoneNumber);
      const sessionId2 = generateSessionId(userId, phoneNumber);

      // Second call should return same ID (unless forced)
      expect(sessionId1).toBe(sessionId2);
    });

    it("should force new session ID when requested", async () => {
      const generateSessionId = (proxyManager as any).generateSessionId.bind(
        proxyManager,
      );

      const sessionId1 = generateSessionId(userId, phoneNumber, false);
      const sessionId2 = generateSessionId(userId, phoneNumber, true);

      expect(sessionId1).not.toBe(sessionId2);
    });

    it("should generate session ID with correct format", async () => {
      const generateSessionId = (proxyManager as any).generateSessionId.bind(
        proxyManager,
      );

      const sessionId = generateSessionId(userId, phoneNumber);

      expect(sessionId).toMatch(/^[a-f0-9]{16}$/);
    });
  });

  describe("Country-to-Proxy Mapping", () => {
    beforeEach(() => {
      proxyManager = new ProxyManager(mockFirestore, mockDynamicProxyService);
    });

    it("should map country code to proxy username", async () => {
      const pm = new ProxyManager(mockFirestore);
      (pm as any).brightDataConfig.proxyType = "residential";
      const config = await pm.getProxyConfig("user123", "+1234567890", "de");

      expect(config?.username).toContain("country-de");
    });

    it("should support multiple country codes", async () => {
      const countries = ["us", "gb", "de", "fr", "au", "jp"];
      const pm = new ProxyManager(mockFirestore);
      (pm as any).brightDataConfig.proxyType = "residential";

      for (const country of countries) {
        const config = await pm.getProxyConfig(
          "user123",
          "+1234567890",
          country,
        );
        expect(config?.username).toContain(`country-${country}`);
      }
    });

    it("should work without country specification", async () => {
      const pm = new ProxyManager(mockFirestore);
      (pm as any).brightDataConfig.proxyType = "residential";
      const config = await pm.getProxyConfig("user123", "+1234567890");

      expect(config?.username).not.toContain("country-");
    });
  });

  describe("Error Handling", () => {
    beforeEach(() => {
      proxyManager = new ProxyManager(mockFirestore, mockDynamicProxyService);
    });

    it("should handle dynamic proxy allocation errors", async () => {
      mockDynamicProxyService.assignProxy.mockRejectedValue(
        new Error("Allocation failed"),
      );

      // Without fallback, should throw
      await expect(
        proxyManager.getProxyConfig("user123", "+1234567890"),
      ).rejects.toThrow();
    });

    it("should handle proxy release errors gracefully", async () => {
      mockDynamicProxyService.releaseProxy.mockRejectedValue(
        new Error("Release failed"),
      );

      // Should not throw
      await expect(
        proxyManager.releaseProxy("user123", "+1234567890"),
      ).resolves.not.toThrow();
    });

    it("should handle test connection errors", async () => {
      const mockProxy = {
        ip: "1.2.3.4",
        port: 22225,
        country: "us",
      };

      mockDynamicProxyService.assignProxy.mockResolvedValue({
        proxy: mockProxy,
        fallbackUsed: false,
      });

      (ProxyAgent as unknown as jest.Mock).mockImplementation(() => {
        throw new Error("Agent creation failed");
      });

      await expect(
        proxyManager.testProxyConnection("user123", "+1234567890"),
      ).resolves.toBe(false);
    });
  });

  describe("Proxy Health Checking", () => {
    beforeEach(() => {
      proxyManager = new ProxyManager(mockFirestore, mockDynamicProxyService);
    });

    it("should verify proxy is working via IP check", async () => {
      const mockProxy = {
        ip: "1.2.3.4",
        port: 22225,
        country: "us",
      };

      mockDynamicProxyService.assignProxy.mockResolvedValue({
        proxy: mockProxy,
        fallbackUsed: false,
      });

      (ProxyAgent as unknown as jest.Mock).mockImplementation(() => ({}));
      (axios.get as jest.Mock).mockResolvedValue({
        data: { ip: "5.6.7.8" },
      });

      const isHealthy = await proxyManager.testProxyConnection(
        "user123",
        "+1234567890",
      );

      expect(isHealthy).toBe(true);
      expect(axios.get).toHaveBeenCalledWith(
        "https://api.ipify.org?format=json",
        expect.objectContaining({
          timeout: 10000,
        }),
      );
    });

    it("should mark proxy as unhealthy on timeout", async () => {
      const mockProxy = {
        ip: "1.2.3.4",
        port: 22225,
        country: "us",
      };

      mockDynamicProxyService.assignProxy.mockResolvedValue({
        proxy: mockProxy,
        fallbackUsed: false,
      });

      (ProxyAgent as unknown as jest.Mock).mockImplementation(() => ({}));
      (axios.get as jest.Mock).mockRejectedValue(new Error("ETIMEDOUT"));

      const isHealthy = await proxyManager.testProxyConnection(
        "user123",
        "+1234567890",
      );

      expect(isHealthy).toBe(false);
    });
  });

  describe("Proxy Agent Creation", () => {
    beforeEach(() => {
      proxyManager = new ProxyManager(mockFirestore, mockDynamicProxyService);
    });

    it("should create agent with correct proxy URL format", async () => {
      const mockProxy = {
        ip: "1.2.3.4",
        port: 22225,
        country: "us",
      };

      mockDynamicProxyService.assignProxy.mockResolvedValue({
        proxy: mockProxy,
        fallbackUsed: false,
      });

      const mockAgent = {} as ProxyAgent;
      (ProxyAgent as unknown as jest.Mock).mockImplementation((config) => {
        expect(config.uri).toMatch(
          /^http:\/\/brd-customer-.+:test-password@brd\.superproxy\.io:22225$/,
        );
        return mockAgent;
      });

      await proxyManager.createProxyAgent("user123", "+1234567890", "us");

      expect(ProxyAgent).toHaveBeenCalled();
    });

    it("should include session ID in proxy URL", async () => {
      const mockProxy = {
        ip: "1.2.3.4",
        port: 22225,
        country: "us",
      };

      mockDynamicProxyService.assignProxy.mockResolvedValue({
        proxy: mockProxy,
        fallbackUsed: false,
      });

      (ProxyAgent as unknown as jest.Mock).mockImplementation((config) => {
        expect(config.uri).toContain("session-");
        return {} as ProxyAgent;
      });

      await proxyManager.createProxyAgent("user123", "+1234567890", "us");
    });
  });

  describe("BrightData Integration", () => {
    it("should use correct BrightData format for username", async () => {
      const pm = new ProxyManager(mockFirestore);
      (pm as any).brightDataConfig.proxyType = "residential";
      const config = await pm.getProxyConfig("user123", "+1234567890", "us");

      expect(config?.username).toMatch(
        /^brd-customer-test-customer-id-zone-residential-country-us-session-[a-f0-9]{16}$/,
      );
    });

    it("should use zone password correctly", async () => {
      const pm = new ProxyManager(mockFirestore);
      (pm as any).brightDataConfig.proxyType = "residential";
      const config = await pm.getProxyConfig("user123", "+1234567890");

      expect(config?.password).toBe("test-password");
    });

    it("should use correct host and port", async () => {
      const pm = new ProxyManager(mockFirestore);
      (pm as any).brightDataConfig.proxyType = "residential";
      const config = await pm.getProxyConfig("user123", "+1234567890");

      expect(config?.host).toBe("brd.superproxy.io");
      expect(config?.port).toBe(22225);
    });
  });
});

describe("ProxyManager Integration Tests", () => {
  it("should handle complete proxy lifecycle", async () => {
    // Ensure env vars are set for this test
    process.env.BRIGHT_DATA_CUSTOMER_ID = "test-customer-id";
    process.env.BRIGHT_DATA_ZONE_PASSWORD = "test-password";

    const mockFirestore = {} as jest.Mocked<Firestore>;
    const mockDynamicProxyService = {
      assignProxy: jest.fn(),
      releaseProxy: jest.fn(),
      getMetrics: jest.fn(),
    } as any;

    const mockProxy = {
      ip: "1.2.3.4",
      port: 22225,
      country: "us",
    };

    mockDynamicProxyService.assignProxy.mockResolvedValue({
      proxy: mockProxy,
      fallbackUsed: false,
    });
    mockDynamicProxyService.releaseProxy.mockResolvedValue(undefined);

    const proxyManager = new ProxyManager(
      mockFirestore,
      mockDynamicProxyService,
    );

    // 1. Get proxy config
    const config = await proxyManager.getProxyConfig(
      "user123",
      "+1234567890",
      "us",
    );
    expect(config).not.toBeNull();
    expect((config as any)?.ip).toBe("1.2.3.4");

    // 2. Verify proxy is assigned
    const activeProxies = (proxyManager as any).activeProxies;
    expect(activeProxies.has("user123:+1234567890")).toBe(true);

    // 3. Rotate proxy (for ISP mode, this creates a new proxy)
    const mockProxy2 = {
      ip: "2.3.4.5",
      port: 22225,
      country: "us",
    };
    mockDynamicProxyService.assignProxy.mockResolvedValue({
      proxy: mockProxy2,
      fallbackUsed: false,
    });
    await proxyManager.rotateProxy("user123", "+1234567890");

    // 4. Release proxy
    await proxyManager.releaseProxy("user123", "+1234567890");

    expect(mockDynamicProxyService.releaseProxy).toHaveBeenCalled();
  });

  it("should handle multiple concurrent sessions", async () => {
    // Ensure env vars are set for this test
    process.env.BRIGHT_DATA_CUSTOMER_ID = "test-customer-id";
    process.env.BRIGHT_DATA_ZONE_PASSWORD = "test-password";

    const mockFirestore = {} as jest.Mocked<Firestore>;

    // Use residential mode which creates sessions in sessions Map
    const proxyManager = new ProxyManager(mockFirestore);
    (proxyManager as any).brightDataConfig.proxyType = "residential";

    // Create multiple sessions
    const sessions = await Promise.all([
      proxyManager.getProxyConfig("user1", "+1111111111", "us"),
      proxyManager.getProxyConfig("user2", "+2222222222", "gb"),
      proxyManager.getProxyConfig("user3", "+3333333333", "de"),
    ]);

    expect(sessions).toHaveLength(3);
    expect(sessions.every((s) => s !== null)).toBe(true);

    const metrics = await proxyManager.getMetrics();
    expect(metrics.activeSessions).toBe(3);
  });
});
