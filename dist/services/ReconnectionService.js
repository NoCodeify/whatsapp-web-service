"use strict";
var __createBinding =
  (this && this.__createBinding) ||
  (Object.create
    ? function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        var desc = Object.getOwnPropertyDescriptor(m, k);
        if (
          !desc ||
          ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)
        ) {
          desc = {
            enumerable: true,
            get: function () {
              return m[k];
            },
          };
        }
        Object.defineProperty(o, k2, desc);
      }
    : function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        o[k2] = m[k];
      });
var __setModuleDefault =
  (this && this.__setModuleDefault) ||
  (Object.create
    ? function (o, v) {
        Object.defineProperty(o, "default", { enumerable: true, value: v });
      }
    : function (o, v) {
        o["default"] = v;
      });
var __importStar =
  (this && this.__importStar) ||
  (function () {
    var ownKeys = function (o) {
      ownKeys =
        Object.getOwnPropertyNames ||
        function (o) {
          var ar = [];
          for (var k in o)
            if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
          return ar;
        };
      return ownKeys(o);
    };
    return function (mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null)
        for (var k = ownKeys(mod), i = 0; i < k.length; i++)
          if (k[i] !== "default") __createBinding(result, mod, k[i]);
      __setModuleDefault(result, mod);
      return result;
    };
  })();
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReconnectionService = void 0;
const pino_1 = __importDefault(require("pino"));
const crypto = __importStar(require("crypto"));
const phoneNumber_1 = require("../utils/phoneNumber");
const logger = (0, pino_1.default)({ name: "ReconnectionService" });
class ReconnectionService {
  sessionManager;
  connectionPool;
  firestore;
  recentAttempts = new Map();
  // Rate limiting configuration
  MAX_ATTEMPTS_PER_HOUR = 3;
  RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
  constructor(sessionManager, connectionPool, firestore) {
    this.sessionManager = sessionManager;
    this.connectionPool = connectionPool;
    this.firestore = firestore;
    // Clean up old attempts every hour
    setInterval(() => {
      this.cleanupOldAttempts();
    }, this.RATE_LIMIT_WINDOW_MS);
  }
  /**
   * Check if a user can reconnect to their session
   */
  async canReconnect(userId, phoneNumber) {
    try {
      // Format phone number
      const formattedPhone = (0, phoneNumber_1.formatPhoneNumberSafe)(
        phoneNumber,
      );
      if (!formattedPhone) {
        return {
          canReconnect: false,
          reason: "Invalid phone number format",
          sessionExists: false,
          rateLimited: false,
        };
      }
      phoneNumber = formattedPhone;
      // Check rate limiting
      const rateLimitCheck = this.checkRateLimit(userId, phoneNumber);
      if (rateLimitCheck.isLimited) {
        return {
          canReconnect: false,
          reason: "Too many reconnection attempts",
          sessionExists: false,
          rateLimited: true,
          retryAfter: rateLimitCheck.retryAfter,
        };
      }
      // Check if session exists
      const sessionExists = await this.sessionManager.sessionExists(
        userId,
        phoneNumber,
      );
      if (!sessionExists) {
        return {
          canReconnect: false,
          reason: "No session found for this phone number",
          sessionExists: false,
          rateLimited: false,
        };
      }
      // Check if user has active connection already
      const existingConnection = this.connectionPool.getConnection(
        userId,
        phoneNumber,
      );
      if (existingConnection) {
        return {
          canReconnect: false,
          reason: "Session is already connected",
          sessionExists: true,
          rateLimited: false,
        };
      }
      return {
        canReconnect: true,
        sessionExists: true,
        rateLimited: false,
      };
    } catch (error) {
      logger.error(
        { error, userId, phoneNumber },
        "Error checking if reconnection is possible",
      );
      return {
        canReconnect: false,
        reason: "Internal error checking reconnection status",
        sessionExists: false,
        rateLimited: false,
      };
    }
  }
  /**
   * Attempt to reconnect a user to their WhatsApp Web session
   */
  async reconnect(userId, phoneNumber, forceNew = false) {
    try {
      // Format phone number
      const formattedPhone = (0, phoneNumber_1.formatPhoneNumberSafe)(
        phoneNumber,
      );
      if (!formattedPhone) {
        return {
          success: false,
          status: "failed",
          message: "Invalid phone number format",
        };
      }
      phoneNumber = formattedPhone;
      logger.info(
        { userId, phoneNumber, forceNew },
        "Starting reconnection attempt",
      );
      // Record this attempt for rate limiting
      this.recordAttempt(userId, phoneNumber);
      // Check rate limiting again
      const rateLimitCheck = this.checkRateLimit(userId, phoneNumber);
      if (rateLimitCheck.isLimited) {
        return {
          success: false,
          status: "rate_limited",
          message: "Too many reconnection attempts",
          retryAfter: rateLimitCheck.retryAfter,
        };
      }
      // Check if session exists
      if (
        !forceNew &&
        !(await this.sessionManager.sessionExists(userId, phoneNumber))
      ) {
        return {
          success: false,
          status: "session_not_found",
          message:
            "No session found. Use forceNew=true to create a new session.",
        };
      }
      // Get user's country for proxy selection
      const userCountry = await this.getUserCountry(userId, phoneNumber);
      // Create new connection through the connection pool
      // This will reuse existing session files and create a new connection
      const success = await this.connectionPool.addConnection(
        userId,
        phoneNumber,
        userCountry,
      );
      if (success) {
        logger.info(
          { userId, phoneNumber },
          "Successfully reconnected WhatsApp Web session",
        );
        return {
          success: true,
          status: "connected",
          message: "Successfully reconnected to WhatsApp Web",
        };
      } else {
        logger.warn(
          { userId, phoneNumber },
          "Failed to reconnect WhatsApp Web session",
        );
        return {
          success: false,
          status: "failed",
          message: "Failed to establish WhatsApp Web connection",
        };
      }
    } catch (error) {
      logger.error(
        { error, userId, phoneNumber },
        "Failed to reconnect WhatsApp Web session",
      );
      // Check if this is a QR code needed scenario
      if (error.message?.includes("QR") || error.message?.includes("pairing")) {
        return {
          success: false,
          status: "needs_qr",
          message: "Session expired. Please scan QR code to reconnect.",
        };
      }
      return {
        success: false,
        status: "failed",
        message: `Reconnection failed: ${error.message}`,
      };
    }
  }
  /**
   * Generate a secure reconnection token for a user
   */
  generateReconnectionToken(userId, phoneNumber) {
    const data = {
      userId,
      phoneNumber,
      timestamp: Date.now(),
      expires: Date.now() + 60 * 60 * 1000, // 1 hour
    };
    const token = Buffer.from(JSON.stringify(data)).toString("base64");
    const hash = crypto
      .createHash("sha256")
      .update(token + process.env.SESSION_ENCRYPTION_KEY)
      .digest("hex");
    return `${token}.${hash}`;
  }
  /**
   * Validate a reconnection token
   */
  validateReconnectionToken(token) {
    try {
      const [tokenData, hash] = token.split(".");
      // Verify hash
      const expectedHash = crypto
        .createHash("sha256")
        .update(tokenData + process.env.SESSION_ENCRYPTION_KEY)
        .digest("hex");
      if (hash !== expectedHash) {
        return null;
      }
      const data = JSON.parse(Buffer.from(tokenData, "base64").toString());
      // Check expiration
      if (Date.now() > data.expires) {
        return null;
      }
      return {
        userId: data.userId,
        phoneNumber: data.phoneNumber,
      };
    } catch {
      return null;
    }
  }
  /**
   * Get user's country from Firestore
   */
  async getUserCountry(userId, phoneNumber) {
    try {
      const phoneDoc = await this.firestore
        .collection("users")
        .doc(userId)
        .collection("phone_numbers")
        .doc(phoneNumber)
        .get();
      const phoneData = phoneDoc.data();
      return phoneData?.country_code || phoneData?.proxy_country;
    } catch (error) {
      logger.debug(
        { error, userId, phoneNumber },
        "Failed to get user country, using default",
      );
      return undefined;
    }
  }
  /**
   * Check if user is rate limited
   */
  checkRateLimit(userId, phoneNumber) {
    const key = `${userId}:${phoneNumber}`;
    const attempts = this.recentAttempts.get(key) || [];
    const recentAttempts = attempts.filter(
      (attempt) =>
        Date.now() - attempt.timestamp.getTime() < this.RATE_LIMIT_WINDOW_MS,
    );
    if (recentAttempts.length >= this.MAX_ATTEMPTS_PER_HOUR) {
      const oldestAttempt = recentAttempts[0];
      const retryAfter = Math.ceil(
        (oldestAttempt.timestamp.getTime() +
          this.RATE_LIMIT_WINDOW_MS -
          Date.now()) /
          1000,
      );
      return { isLimited: true, retryAfter };
    }
    return { isLimited: false };
  }
  /**
   * Record a reconnection attempt
   */
  recordAttempt(userId, phoneNumber) {
    const key = `${userId}:${phoneNumber}`;
    const attempts = this.recentAttempts.get(key) || [];
    attempts.push({
      userId,
      phoneNumber,
      timestamp: new Date(),
    });
    // Keep only recent attempts
    const recentAttempts = attempts.filter(
      (attempt) =>
        Date.now() - attempt.timestamp.getTime() < this.RATE_LIMIT_WINDOW_MS,
    );
    this.recentAttempts.set(key, recentAttempts);
  }
  /**
   * Clean up old reconnection attempts
   */
  cleanupOldAttempts() {
    const cutoffTime = Date.now() - this.RATE_LIMIT_WINDOW_MS;
    for (const [key, attempts] of this.recentAttempts.entries()) {
      const recentAttempts = attempts.filter(
        (attempt) => attempt.timestamp.getTime() > cutoffTime,
      );
      if (recentAttempts.length === 0) {
        this.recentAttempts.delete(key);
      } else {
        this.recentAttempts.set(key, recentAttempts);
      }
    }
    logger.debug(
      { keys: this.recentAttempts.size },
      "Cleaned up old reconnection attempts",
    );
  }
  /**
   * Get reconnection statistics for monitoring
   */
  getStats() {
    let totalAttempts = 0;
    let rateLimitedUsers = 0;
    for (const attempts of this.recentAttempts.values()) {
      totalAttempts += attempts.length;
      if (attempts.length >= this.MAX_ATTEMPTS_PER_HOUR) {
        rateLimitedUsers++;
      }
    }
    return {
      totalAttempts,
      uniqueUsers: this.recentAttempts.size,
      rateLimitedUsers,
    };
  }
}
exports.ReconnectionService = ReconnectionService;
//# sourceMappingURL=ReconnectionService.js.map
