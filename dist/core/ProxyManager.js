"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProxyManager = void 0;
const proxy_agent_1 = require("proxy-agent");
const pino_1 = __importDefault(require("pino"));
const crypto_1 = __importDefault(require("crypto"));
const BrightDataService_1 = require("../services/BrightDataService");
class ProxyManager {
    logger = (0, pino_1.default)({ name: "ProxyManager" });
    sessions = new Map();
    activeProxies = new Map();
    brightDataService;
    dynamicProxyService;
    _firestore;
    brightDataConfig = {
        host: process.env.BRIGHT_DATA_HOST || "brd.superproxy.io",
        port: parseInt(process.env.BRIGHT_DATA_PORT || "22225"),
        customerID: process.env.BRIGHT_DATA_CUSTOMER_ID || "",
        zone: process.env.BRIGHT_DATA_ZONE || "residential",
        zonePassword: process.env.BRIGHT_DATA_ZONE_PASSWORD || "",
        proxyType: "isp",
    };
    // Available proxy locations supported by Bright Data
    availableLocations = [
        // North America
        {
            code: "us",
            name: "United States",
            flag: "🇺🇸",
            available: true,
            region: "northAmerica",
        },
        {
            code: "ca",
            name: "Canada",
            flag: "🇨🇦",
            available: true,
            region: "northAmerica",
        },
        {
            code: "mx",
            name: "Mexico",
            flag: "🇲🇽",
            available: true,
            region: "northAmerica",
        },
        // Europe
        {
            code: "gb",
            name: "United Kingdom",
            flag: "🇬🇧",
            available: true,
            region: "europe",
        },
        {
            code: "de",
            name: "Germany",
            flag: "🇩🇪",
            available: true,
            region: "europe",
        },
        {
            code: "fr",
            name: "France",
            flag: "🇫🇷",
            available: true,
            region: "europe",
        },
        {
            code: "nl",
            name: "Netherlands",
            flag: "🇳🇱",
            available: true,
            region: "europe",
        },
        {
            code: "es",
            name: "Spain",
            flag: "🇪🇸",
            available: true,
            region: "europe",
        },
        {
            code: "it",
            name: "Italy",
            flag: "🇮🇹",
            available: true,
            region: "europe",
        },
        {
            code: "pl",
            name: "Poland",
            flag: "🇵🇱",
            available: true,
            region: "europe",
        },
        {
            code: "se",
            name: "Sweden",
            flag: "🇸🇪",
            available: true,
            region: "europe",
        },
        {
            code: "no",
            name: "Norway",
            flag: "🇳🇴",
            available: true,
            region: "europe",
        },
        {
            code: "dk",
            name: "Denmark",
            flag: "🇩🇰",
            available: true,
            region: "europe",
        },
        {
            code: "fi",
            name: "Finland",
            flag: "🇫🇮",
            available: true,
            region: "europe",
        },
        {
            code: "be",
            name: "Belgium",
            flag: "🇧🇪",
            available: true,
            region: "europe",
        },
        {
            code: "ch",
            name: "Switzerland",
            flag: "🇨🇭",
            available: true,
            region: "europe",
        },
        {
            code: "at",
            name: "Austria",
            flag: "🇦🇹",
            available: true,
            region: "europe",
        },
        {
            code: "ie",
            name: "Ireland",
            flag: "🇮🇪",
            available: true,
            region: "europe",
        },
        {
            code: "pt",
            name: "Portugal",
            flag: "🇵🇹",
            available: true,
            region: "europe",
        },
        // Asia Pacific
        {
            code: "au",
            name: "Australia",
            flag: "🇦🇺",
            available: true,
            region: "asiaPacific",
        },
        {
            code: "nz",
            name: "New Zealand",
            flag: "🇳🇿",
            available: true,
            region: "asiaPacific",
        },
        {
            code: "jp",
            name: "Japan",
            flag: "🇯🇵",
            available: true,
            region: "asiaPacific",
        },
        {
            code: "sg",
            name: "Singapore",
            flag: "🇸🇬",
            available: true,
            region: "asiaPacific",
        },
        {
            code: "hk",
            name: "Hong Kong",
            flag: "🇭🇰",
            available: true,
            region: "asiaPacific",
        },
        {
            code: "in",
            name: "India",
            flag: "🇮🇳",
            available: true,
            region: "asiaPacific",
        },
        {
            code: "id",
            name: "Indonesia",
            flag: "🇮🇩",
            available: true,
            region: "asiaPacific",
        },
        {
            code: "my",
            name: "Malaysia",
            flag: "🇲🇾",
            available: true,
            region: "asiaPacific",
        },
        {
            code: "th",
            name: "Thailand",
            flag: "🇹🇭",
            available: true,
            region: "asiaPacific",
        },
        {
            code: "ph",
            name: "Philippines",
            flag: "🇵🇭",
            available: true,
            region: "asiaPacific",
        },
        {
            code: "vn",
            name: "Vietnam",
            flag: "🇻🇳",
            available: true,
            region: "asiaPacific",
        },
        {
            code: "kr",
            name: "South Korea",
            flag: "🇰🇷",
            available: true,
            region: "asiaPacific",
        },
        {
            code: "tw",
            name: "Taiwan",
            flag: "🇹🇼",
            available: true,
            region: "asiaPacific",
        },
        // Middle East & Africa
        {
            code: "ae",
            name: "United Arab Emirates",
            flag: "🇦🇪",
            available: true,
            region: "mea",
        },
        {
            code: "sa",
            name: "Saudi Arabia",
            flag: "🇸🇦",
            available: true,
            region: "mea",
        },
        { code: "il", name: "Israel", flag: "🇮🇱", available: true, region: "mea" },
        { code: "tr", name: "Turkey", flag: "🇹🇷", available: true, region: "mea" },
        {
            code: "za",
            name: "South Africa",
            flag: "🇿🇦",
            available: true,
            region: "mea",
        },
        { code: "eg", name: "Egypt", flag: "🇪🇬", available: true, region: "mea" },
        { code: "ng", name: "Nigeria", flag: "🇳🇬", available: true, region: "mea" },
        { code: "ke", name: "Kenya", flag: "🇰🇪", available: true, region: "mea" },
        // South America
        {
            code: "br",
            name: "Brazil",
            flag: "🇧🇷",
            available: true,
            region: "southAmerica",
        },
        {
            code: "ar",
            name: "Argentina",
            flag: "🇦🇷",
            available: true,
            region: "southAmerica",
        },
        {
            code: "cl",
            name: "Chile",
            flag: "🇨🇱",
            available: true,
            region: "southAmerica",
        },
        {
            code: "co",
            name: "Colombia",
            flag: "🇨🇴",
            available: true,
            region: "southAmerica",
        },
        {
            code: "pe",
            name: "Peru",
            flag: "🇵🇪",
            available: true,
            region: "southAmerica",
        },
    ];
    constructor(firestore, dynamicProxyService) {
        this._firestore = firestore;
        this.dynamicProxyService = dynamicProxyService;
        // Check if proxy is explicitly disabled
        const useProxy = process.env.USE_PROXY !== "false";
        if (!useProxy) {
            this.logger.info("Proxy explicitly disabled via USE_PROXY=false");
            this.brightDataConfig.customerID = "";
            this.brightDataConfig.zonePassword = "";
        }
        else if (!this.brightDataConfig.customerID ||
            !this.brightDataConfig.zonePassword) {
            this.logger.warn("Bright Data credentials not configured. Running without proxy.");
        }
        else {
            // For ISP proxies with dynamic allocation enabled
            if (this.brightDataConfig.proxyType === "isp") {
                if (this.dynamicProxyService) {
                    this.logger.info("Using DynamicProxyService for ISP proxy management with direct purchase/release");
                }
                else if (this._firestore) {
                    // Fallback to static IP management
                    this.brightDataService = new BrightDataService_1.BrightDataService(this._firestore);
                    this.logger.info("Initialized BrightDataService for ISP proxy management (static IPs only)");
                }
            }
        }
    }
    /**
     * Generate a unique session ID for sticky IP assignment
     */
    generateSessionId(userId, phoneNumber, forceNew = false) {
        const key = `${userId}:${phoneNumber}`;
        if (!forceNew && this.sessions.has(key)) {
            const session = this.sessions.get(key);
            session.lastUsed = new Date();
            return session.sessionId;
        }
        // Generate new session ID using crypto for uniqueness
        const sessionId = crypto_1.default
            .createHash("md5")
            .update(`${userId}_${phoneNumber}_${Date.now()}_${Math.random()}`)
            .digest("hex")
            .substring(0, 16);
        const session = {
            userId,
            phoneNumber,
            sessionId,
            createdAt: new Date(),
            lastUsed: new Date(),
            rotationCount: 0,
        };
        this.sessions.set(key, session);
        this.logger.info({ userId, phoneNumber, sessionId }, "Generated new proxy session");
        return sessionId;
    }
    /**
     * Get proxy configuration for a specific user/phone combination
     */
    async getProxyConfig(userId, phoneNumber, country) {
        // If no credentials configured, return null (no proxy)
        if (!this.brightDataConfig.customerID ||
            !this.brightDataConfig.zonePassword) {
            return null;
        }
        // For ISP proxies, prefer DynamicProxyService (direct purchase/release) over BrightDataService (static)
        if (this.brightDataConfig.proxyType === "isp") {
            // Try DynamicProxyService first (direct purchase/release)
            if (this.dynamicProxyService) {
                try {
                    const requestedCountry = country || "us"; // Default to US if no country specified
                    const dynamicResult = await this.dynamicProxyService.assignProxy(userId, phoneNumber, requestedCountry);
                    if (dynamicResult && dynamicResult.proxy) {
                        const proxy = dynamicResult.proxy;
                        const sessionId = `${userId}_${phoneNumber}_${proxy.ip}`;
                        // Convert to ProxyConfig format
                        const dynamicConfig = {
                            host: this.brightDataConfig.host,
                            port: this.brightDataConfig.port,
                            username: `brd-customer-${this.brightDataConfig.customerID}-zone-${this.brightDataConfig.zone}-session-${sessionId}`,
                            password: this.brightDataConfig.zonePassword,
                            sessionId: sessionId,
                            type: "isp",
                            country: proxy.country,
                            ip: proxy.ip,
                            proxyPort: proxy.port,
                            fallbackUsed: dynamicResult.fallbackUsed,
                        };
                        // Store proxy info for later release
                        const connectionKey = `${userId}:${phoneNumber}`;
                        this.activeProxies.set(connectionKey, {
                            ip: proxy.ip,
                            country: proxy.country,
                            assignedAt: new Date(),
                        });
                        this.logger.info({
                            userId,
                            phoneNumber,
                            type: "isp_dynamic",
                            country: proxy.country,
                            sessionId: sessionId,
                            ip: proxy.ip,
                            proxyPort: proxy.port,
                            fallbackUsed: dynamicResult.fallbackUsed,
                        }, "Using dynamic ISP proxy with direct purchase");
                        return dynamicConfig;
                    }
                }
                catch (error) {
                    this.logger.warn({ error, userId, phoneNumber, requestedCountry: country }, "Dynamic proxy allocation failed, falling back to static assignment");
                }
            }
            // Fallback to BrightDataService (static IP assignment)
            if (this.brightDataService) {
                const ispConfig = await this.brightDataService.getProxyConfig(userId, phoneNumber);
                if (ispConfig) {
                    this.logger.info({
                        userId,
                        phoneNumber,
                        type: "isp_static",
                        sessionId: ispConfig.sessionId,
                    }, "Using static ISP proxy with dedicated IP assignment");
                    return ispConfig;
                }
                else {
                    // CRITICAL SAFETY: If no proxy available in ISP mode, do NOT allow connection
                    // This prevents exposing user's real IP address
                    this.logger.error({ userId, phoneNumber, proxyType: "isp" }, "SECURITY: No ISP proxy available - blocking connection to prevent IP exposure");
                    throw new Error("No proxy available for secure connection. Connection blocked to protect user privacy.");
                }
            }
            // If no proxy services are configured in ISP mode, block connection
            this.logger.error({ userId, phoneNumber, proxyType: "isp" }, "SECURITY: ISP proxy type configured but no proxy services available - blocking connection");
            throw new Error("Proxy service not configured. Connection blocked to protect user privacy.");
        }
        // Fallback to session-based residential proxy
        const sessionId = this.generateSessionId(userId, phoneNumber);
        // Store selected country in session
        const key = `${userId}:${phoneNumber}`;
        if (this.sessions.has(key)) {
            const session = this.sessions.get(key);
            session.selectedCountry = country;
        }
        // Bright Data username format for sticky sessions with country targeting
        let username = `brd-customer-${this.brightDataConfig.customerID}-zone-${this.brightDataConfig.zone}`;
        if (country) {
            // Add country targeting to get IP from specific country
            username += `-country-${country}`;
        }
        username += `-session-${sessionId}`;
        const config = {
            host: this.brightDataConfig.host,
            port: this.brightDataConfig.port,
            username,
            password: this.brightDataConfig.zonePassword,
            sessionId,
            country,
            type: "residential",
        };
        this.logger.debug({ userId, phoneNumber, sessionId, country, type: "residential" }, "Generated proxy configuration");
        return config;
    }
    /**
     * Create a proxy agent for HTTP/HTTPS requests
     */
    async createProxyAgent(userId, phoneNumber, country) {
        const proxyConfig = await this.getProxyConfig(userId, phoneNumber, country);
        if (!proxyConfig) {
            return null;
        }
        // Construct proxy URL
        const proxyUrl = `http://${proxyConfig.username}:${proxyConfig.password}@${proxyConfig.host}:${proxyConfig.port}`;
        const agent = new proxy_agent_1.ProxyAgent({ uri: proxyUrl });
        this.logger.debug({ userId, phoneNumber, country }, "Created proxy agent");
        return agent;
    }
    /**
     * Get available proxy locations
     */
    getAvailableLocations() {
        return this.availableLocations;
    }
    /**
     * Find nearest available location based on region
     */
    findNearestLocation(userCountry) {
        // Check if user's country is available
        const userLocation = this.availableLocations.find((l) => l.code === userCountry);
        if (userLocation && userLocation.available) {
            return userCountry;
        }
        // If not available, find another location in the same region
        if (userLocation) {
            const sameRegionLocations = this.availableLocations.filter((l) => l.region === userLocation.region && l.available);
            if (sameRegionLocations.length > 0) {
                return sameRegionLocations[0].code;
            }
        }
        // Regional fallbacks based on proximity
        const regionalFallbacks = {
            // Europe fallback chain
            europe: ["gb", "de", "fr", "nl"],
            // North America fallback chain
            northAmerica: ["us", "ca"],
            // Asia Pacific fallback chain
            asiaPacific: ["sg", "au", "jp", "hk"],
            // Middle East & Africa fallback chain
            mea: ["ae", "za", "tr"],
            // South America fallback chain
            southAmerica: ["br", "ar", "cl"],
        };
        // Try regional fallback
        for (const region of Object.keys(regionalFallbacks)) {
            const fallbacks = regionalFallbacks[region];
            for (const fallback of fallbacks) {
                if (this.availableLocations.find((l) => l.code === fallback && l.available)) {
                    return fallback;
                }
            }
        }
        // Default to US if all else fails
        return "us";
    }
    /**
     * Release proxy when user disconnects
     */
    async releaseProxy(userId, phoneNumber) {
        if (this.dynamicProxyService) {
            try {
                // Get the assigned proxy IP from memory
                const connectionKey = `${userId}:${phoneNumber}`;
                const proxyInfo = this.activeProxies.get(connectionKey);
                if (proxyInfo) {
                    // Directly release the proxy
                    await this.dynamicProxyService.releaseProxy(proxyInfo.ip);
                    // Remove from memory
                    this.activeProxies.delete(connectionKey);
                    this.logger.info({ userId, phoneNumber, ip: proxyInfo.ip }, "Proxy released directly");
                }
                else {
                    this.logger.debug({ userId, phoneNumber }, "No proxy found to release");
                }
            }
            catch (error) {
                this.logger.error({ error: error.message, userId, phoneNumber }, "Failed to release proxy");
            }
        }
    }
    /**
     * Rotate proxy by generating a new session ID
     */
    async rotateProxy(userId, phoneNumber) {
        const key = `${userId}:${phoneNumber}`;
        // Increment rotation count if session exists
        if (this.sessions.has(key)) {
            const session = this.sessions.get(key);
            session.rotationCount++;
            this.logger.info({ userId, phoneNumber, rotationCount: session.rotationCount }, "Rotating proxy session");
        }
        // Force new session ID generation
        this.generateSessionId(userId, phoneNumber, true);
        return this.getProxyConfig(userId, phoneNumber);
    }
    /**
     * Get proxy metrics for monitoring
     */
    async getMetrics() {
        const activeSessions = this.sessions.size;
        const totalRotations = Array.from(this.sessions.values()).reduce((sum, session) => sum + session.rotationCount, 0);
        const avgRotationsPerSession = activeSessions > 0 ? totalRotations / activeSessions : 0;
        const oldestSession = Array.from(this.sessions.values()).reduce((oldest, session) => {
            return !oldest || session.createdAt < oldest.createdAt
                ? session
                : oldest;
        }, null);
        // Include dynamic proxy metrics if available
        let dynamicMetrics;
        if (this.dynamicProxyService) {
            dynamicMetrics = await this.dynamicProxyService.getMetrics();
        }
        // Include ISP proxy metrics if available (backward compatibility)
        const ispMetrics = this.brightDataService?.getMetrics();
        return {
            activeSessions,
            totalRotations,
            avgRotationsPerSession,
            oldestSessionAge: oldestSession
                ? Date.now() - oldestSession.createdAt.getTime()
                : 0,
            proxyType: this.brightDataConfig.proxyType,
            ...(dynamicMetrics && { dynamicProxy: dynamicMetrics }),
            ...(ispMetrics && { ispProxy: ispMetrics }),
        };
    }
    /**
     * Clean up old sessions
     */
    cleanupSessions(maxAge = 24 * 60 * 60 * 1000) {
        const now = Date.now();
        let cleaned = 0;
        for (const [key, session] of this.sessions.entries()) {
            if (now - session.lastUsed.getTime() > maxAge) {
                this.sessions.delete(key);
                cleaned++;
            }
        }
        if (cleaned > 0) {
            this.logger.info({ cleaned }, "Cleaned up old proxy sessions");
        }
        return cleaned;
    }
    /**
     * Update session with IP information (called after successful connection)
     */
    updateSessionInfo(userId, phoneNumber, proxyIp, country) {
        const key = `${userId}:${phoneNumber}`;
        if (this.sessions.has(key)) {
            const session = this.sessions.get(key);
            session.proxyIp = proxyIp;
            session.country = country;
            this.logger.info({ userId, phoneNumber, proxyIp, country }, "Updated proxy session info");
        }
    }
    /**
     * Get session information
     */
    getSessionInfo(userId, phoneNumber) {
        const key = `${userId}:${phoneNumber}`;
        return this.sessions.get(key) || null;
    }
    /**
     * Test proxy connection
     */
    async testProxyConnection(userId, phoneNumber) {
        try {
            const agent = await this.createProxyAgent(userId, phoneNumber);
            if (!agent) {
                return true; // No proxy configured, consider it "working"
            }
            // Test connection by making a request to a test endpoint
            const axios = (await Promise.resolve().then(() => __importStar(require("axios")))).default;
            const response = await axios.get("https://api.ipify.org?format=json", {
                httpsAgent: agent,
                timeout: 10000,
            });
            if (response.data && response.data.ip) {
                this.updateSessionInfo(userId, phoneNumber, response.data.ip);
                this.logger.info({ userId, phoneNumber, ip: response.data.ip }, "Proxy connection test successful");
                return true;
            }
            return false;
        }
        catch (error) {
            this.logger.error({ userId, phoneNumber, error }, "Proxy connection test failed");
            return false;
        }
    }
}
exports.ProxyManager = ProxyManager;
//# sourceMappingURL=ProxyManager.js.map