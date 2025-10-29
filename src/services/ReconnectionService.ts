import pino from "pino";
import { SessionManager } from "../core/SessionManager";
import { ConnectionPool } from "../core/ConnectionPool";
import { Firestore } from "@google-cloud/firestore";
import * as crypto from "crypto";
import { formatPhoneNumberSafe } from "../utils/phoneNumber";

const logger = pino({ name: "ReconnectionService" });

export interface ReconnectionAttempt {
  userId: string;
  phoneNumber: string;
  timestamp: Date;
}

export interface ReconnectionResult {
  success: boolean;
  status:
    | "connected"
    | "needs_qr"
    | "failed"
    | "rate_limited"
    | "session_not_found"
    | "timeout"
    | "connection_failed";
  qrCode?: string;
  qrExpiresAt?: Date;
  proxy?: {
    ip?: string;
    country?: string;
    type?: string;
  };
  message?: string;
  retryAfter?: number; // seconds
}

export interface CanReconnectResult {
  canReconnect: boolean;
  reason?: string;
  sessionExists: boolean;
  rateLimited: boolean;
  retryAfter?: number; // seconds
}

export class ReconnectionService {
  private sessionManager: SessionManager;
  private connectionPool: ConnectionPool;
  private firestore: Firestore;
  private recentAttempts: Map<string, ReconnectionAttempt[]> = new Map();

  // Rate limiting configuration
  private readonly MAX_ATTEMPTS_PER_HOUR = 50;
  private readonly RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

  constructor(
    sessionManager: SessionManager,
    connectionPool: ConnectionPool,
    firestore: Firestore,
  ) {
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
  async canReconnect(
    userId: string,
    phoneNumber: string,
  ): Promise<CanReconnectResult> {
    try {
      // Format phone number
      const formattedPhone = formatPhoneNumberSafe(phoneNumber);
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
  async reconnect(
    userId: string,
    phoneNumber: string,
    forceNew = false,
  ): Promise<ReconnectionResult> {
    try {
      // Format phone number
      const formattedPhone = formatPhoneNumberSafe(phoneNumber);
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

      if (!success) {
        logger.warn(
          { userId, phoneNumber },
          "Failed to create connection in pool",
        );

        return {
          success: false,
          status: "failed",
          message: "Failed to establish WhatsApp Web connection",
        };
      }

      // Wait for connection to actually reach "open" state before returning success
      logger.info(
        { userId, phoneNumber },
        "Connection created, waiting for establishment...",
      );

      const connectionResult = await this.connectionPool.waitForConnectionState(
        userId,
        phoneNumber,
        30000, // 30 second timeout
      );

      if (connectionResult.success) {
        logger.info(
          { userId, phoneNumber, state: connectionResult.state },
          "Successfully reconnected WhatsApp Web session",
        );

        return {
          success: true,
          status: "connected",
          message: "Successfully reconnected to WhatsApp Web",
        };
      } else {
        logger.warn(
          {
            userId,
            phoneNumber,
            state: connectionResult.state,
            error: connectionResult.error,
          },
          "Connection failed during establishment",
        );

        // Determine appropriate status based on failure reason
        let status: "failed" | "timeout" | "connection_failed" = "failed";
        if (connectionResult.error?.includes("timeout")) {
          status = "timeout";
        } else if (connectionResult.error?.includes("closed")) {
          status = "connection_failed";
        }

        return {
          success: false,
          status,
          message: connectionResult.error || "Connection failed during establishment",
        };
      }
    } catch (error: any) {
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
  generateReconnectionToken(userId: string, phoneNumber: string): string {
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
  validateReconnectionToken(
    token: string,
  ): { userId: string; phoneNumber: string } | null {
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
  private async getUserCountry(
    userId: string,
    phoneNumber: string,
  ): Promise<string | undefined> {
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
  private checkRateLimit(
    userId: string,
    phoneNumber: string,
  ): { isLimited: boolean; retryAfter?: number } {
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
  private recordAttempt(userId: string, phoneNumber: string): void {
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
  private cleanupOldAttempts(): void {
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
  getStats(): {
    totalAttempts: number;
    uniqueUsers: number;
    rateLimitedUsers: number;
  } {
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
