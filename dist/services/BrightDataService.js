"use strict";
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrightDataService = void 0;
const axios_1 = __importDefault(require("axios"));
const pino_1 = __importDefault(require("pino"));
class BrightDataService {
  logger = (0, pino_1.default)({ name: "BrightDataService" });
  apiClient;
  firestore;
  staticIPs = new Map();
  assignments = new Map();
  config = {
    apiKey: process.env.BRIGHT_DATA_API_KEY || "",
    customerId: process.env.BRIGHT_DATA_CUSTOMER_ID || "",
    zone: process.env.BRIGHT_DATA_ZONE || "",
    zonePassword: process.env.BRIGHT_DATA_ZONE_PASSWORD || "",
    host: process.env.BRIGHT_DATA_HOST || "brd.superproxy.io",
    port: parseInt(process.env.BRIGHT_DATA_PORT || "33335"),
    proxyType: process.env.BRIGHT_DATA_PROXY_TYPE || "isp",
  };
  constructor(firestore) {
    this.firestore = firestore;
    // Initialize API client
    this.apiClient = axios_1.default.create({
      baseURL: "https://api.brightdata.com",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    });
    // Load existing assignments from Firestore on startup
    this.loadAssignments();
    // Periodically sync with Bright Data API
    if (this.config.apiKey) {
      this.syncStaticIPs();
      setInterval(() => this.syncStaticIPs(), 300000); // Sync every 5 minutes
    }
  }
  /**
   * Load existing IP assignments from Firestore
   */
  async loadAssignments() {
    try {
      const snapshot = await this.firestore
        .collection("ip_assignments")
        .where("active", "==", true)
        .get();
      snapshot.forEach((doc) => {
        const data = doc.data();
        this.assignments.set(data.phoneNumber, data);
      });
      this.logger.info(
        { count: this.assignments.size },
        "Loaded existing IP assignments from Firestore",
      );
    } catch (error) {
      this.logger.error({ error }, "Failed to load IP assignments");
    }
  }
  /**
   * Sync available static IPs from Bright Data API
   */
  async syncStaticIPs() {
    try {
      // For ISP proxies, we typically get a pool of IPs
      // This is a mock implementation as Bright Data's exact API may vary
      const response = await this.apiClient.get(
        `/customer/zones/${this.config.zone}/ips`,
      );
      if (response.data && response.data.ips) {
        response.data.ips.forEach((ip) => {
          const staticIP = {
            ip: ip.ip || this.generateSessionBasedIP(),
            port: this.config.port,
            country: ip.country || "US",
            city: ip.city,
            isp: ip.isp,
            status: this.assignments.has(ip.ip) ? "assigned" : "active",
            lastHealthCheck: new Date(),
          };
          this.staticIPs.set(staticIP.ip, staticIP);
        });
        this.logger.info(
          { count: this.staticIPs.size },
          "Synced static IPs from Bright Data",
        );
      }
    } catch (error) {
      // If API fails, generate session-based IPs as fallback
      this.logger.warn(
        { error: error.message },
        "Failed to sync from API, using session-based approach",
      );
      // For ISP proxies, we can use session-based allocation
      // Each session gets a unique IP from the pool
      this.generateSessionBasedIPs();
    }
  }
  /**
   * Generate session-based IP placeholders for ISP proxy
   */
  generateSessionBasedIPs() {
    // For ISP proxies, we don't get specific IPs upfront
    // Instead, we use session IDs to get consistent IPs
    for (let i = 1; i <= 10; i++) {
      const sessionId = `isp_session_${i}`;
      const staticIP = {
        ip: sessionId, // Use session ID as identifier
        port: this.config.port,
        country: "US",
        status: "active",
        sessionId: sessionId,
        lastHealthCheck: new Date(),
      };
      this.staticIPs.set(sessionId, staticIP);
    }
    this.logger.info(
      { count: this.staticIPs.size },
      "Generated session-based IP slots for ISP proxy",
    );
  }
  /**
   * Generate a session-based IP identifier
   */
  generateSessionBasedIP() {
    return `isp_session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  /**
   * Get an available static IP for a phone number
   */
  async assignStaticIP(userId, phoneNumber, preferredCountry) {
    // Check if already assigned
    const existing = this.assignments.get(phoneNumber);
    if (existing) {
      const ip = this.staticIPs.get(existing.ipAddress);
      if (ip) {
        this.logger.info(
          { phoneNumber, ip: ip.ip },
          "Returning existing IP assignment",
        );
        return ip;
      }
    }
    // Find an available IP
    let availableIP = null;
    // First, try to find an IP from preferred country
    if (preferredCountry) {
      for (const ip of this.staticIPs.values()) {
        if (ip.status === "active" && ip.country === preferredCountry) {
          availableIP = ip;
          break;
        }
      }
    }
    // If no country match, get any available IP
    if (!availableIP) {
      for (const ip of this.staticIPs.values()) {
        if (ip.status === "active") {
          availableIP = ip;
          break;
        }
      }
    }
    if (!availableIP) {
      this.logger.warn(
        { phoneNumber, preferredCountry },
        "No available static IPs",
      );
      return null;
    }
    // Create assignment
    const assignment = {
      phoneNumber,
      userId,
      ipAddress: availableIP.ip,
      port: availableIP.port,
      assignedAt: new Date(),
      lastUsed: new Date(),
      country: availableIP.country,
      sessionId: availableIP.sessionId || availableIP.ip,
    };
    // Update IP status
    availableIP.status = "assigned";
    availableIP.assignedTo = phoneNumber;
    availableIP.assignedAt = new Date();
    // Save to Firestore
    await this.firestore
      .collection("ip_assignments")
      .doc(phoneNumber)
      .set({
        ...assignment,
        active: true,
      });
    // Update local cache
    this.assignments.set(phoneNumber, assignment);
    this.logger.info(
      {
        phoneNumber,
        ip: availableIP.ip,
        country: availableIP.country,
      },
      "Assigned static IP to phone number",
    );
    return availableIP;
  }
  /**
   * Release an IP assignment
   */
  async releaseIP(phoneNumber) {
    const assignment = this.assignments.get(phoneNumber);
    if (!assignment) {
      return;
    }
    // Update IP status
    const ip = this.staticIPs.get(assignment.ipAddress);
    if (ip) {
      ip.status = "active";
      ip.assignedTo = undefined;
      ip.assignedAt = undefined;
    }
    // Remove from Firestore
    await this.firestore
      .collection("ip_assignments")
      .doc(phoneNumber)
      .update({ active: false });
    // Remove from local cache
    this.assignments.delete(phoneNumber);
    this.logger.info(
      { phoneNumber, ip: assignment.ipAddress },
      "Released IP assignment",
    );
  }
  /**
   * Get proxy configuration for a phone number
   */
  async getProxyConfig(userId, phoneNumber) {
    const ip = await this.assignStaticIP(userId, phoneNumber);
    if (!ip) {
      return null;
    }
    // For ISP proxies, we use session-based routing
    const sessionId = ip.sessionId || `${userId}_${phoneNumber}`;
    // Build username with session for sticky IP
    const username = `brd-customer-${this.config.customerId}-zone-${this.config.zone}-session-${sessionId}`;
    return {
      host: this.config.host,
      port: this.config.port,
      username,
      password: this.config.zonePassword,
      sessionId,
      type: "isp",
      country: ip.country,
    };
  }
  /**
   * Test proxy connection
   */
  async testConnection(phoneNumber) {
    try {
      const testConfig = phoneNumber
        ? await this.getProxyConfig("test", phoneNumber)
        : {
            host: this.config.host,
            port: this.config.port,
            username: `brd-customer-${this.config.customerId}-zone-${this.config.zone}`,
            password: this.config.zonePassword,
          };
      if (!testConfig) {
        this.logger.error("No proxy configuration available");
        return false;
      }
      // Test connection using curl equivalent
      const response = await axios_1.default.get(
        "https://geo.brdtest.com/welcome.txt",
        {
          proxy: {
            host: testConfig.host,
            port: testConfig.port,
            auth: {
              username: testConfig.username,
              password: testConfig.password,
            },
          },
          timeout: 10000,
        },
      );
      this.logger.info(
        {
          response: response.data,
          status: response.status,
        },
        "ISP proxy connection test successful",
      );
      return response.status === 200;
    } catch (error) {
      this.logger.error(
        { error: error.message },
        "ISP proxy connection test failed",
      );
      return false;
    }
  }
  /**
   * Get all IP assignments
   */
  getAssignments() {
    return Array.from(this.assignments.values());
  }
  /**
   * Get all available IPs
   */
  getAvailableIPs() {
    return Array.from(this.staticIPs.values()).filter(
      (ip) => ip.status === "active",
    );
  }
  /**
   * Get metrics
   */
  getMetrics() {
    const total = this.staticIPs.size;
    const assigned = Array.from(this.staticIPs.values()).filter(
      (ip) => ip.status === "assigned",
    ).length;
    const available = total - assigned;
    return {
      total,
      assigned,
      available,
      assignments: this.assignments.size,
      utilizationRate: total > 0 ? (assigned / total) * 100 : 0,
    };
  }
}
exports.BrightDataService = BrightDataService;
//# sourceMappingURL=BrightDataService.js.map
