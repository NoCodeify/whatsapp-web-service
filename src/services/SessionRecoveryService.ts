import { Firestore, Timestamp } from "@google-cloud/firestore";
import pino from "pino";
import { DynamicProxyService } from "./DynamicProxyService";
import { ConnectionPool } from "../core/ConnectionPool";

export interface RecoverySession {
  userId: string;
  phoneNumber: string;
  proxyIp?: string;
  proxyCountry?: string;
  lastConnected: Date;
  status: "active" | "disconnected" | "error";
  instanceId?: string;
}

export interface RecoveryOptions {
  autoReconnect: boolean;
  maxReconnectAttempts: number;
  reconnectDelay: number;
  priorityCountries?: string[];
}

export class SessionRecoveryService {
  private logger = pino({ name: "SessionRecoveryService" });
  private firestore: Firestore;
  private dynamicProxyService: DynamicProxyService;
  private connectionPool?: ConnectionPool;
  private isRecovering = false;
  private instanceId: string;

  private readonly options: RecoveryOptions = {
    autoReconnect: process.env.AUTO_RECONNECT !== "false",
    maxReconnectAttempts: parseInt(process.env.MAX_RECONNECT_ATTEMPTS || "3"),
    reconnectDelay: parseInt(process.env.RECONNECT_DELAY || "5000"),
    priorityCountries: process.env.PRIORITY_COUNTRIES?.split(",") || [
      "us",
      "gb",
      "de",
    ],
  };

  constructor(
    firestore: Firestore,
    dynamicProxyService: DynamicProxyService,
    instanceId?: string,
  ) {
    this.firestore = firestore;
    this.dynamicProxyService = dynamicProxyService;
    this.instanceId =
      instanceId ||
      `instance_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Mark instance startup
    this.markInstanceStartup();
  }

  /**
   * Set the connection pool reference
   */
  setConnectionPool(connectionPool: ConnectionPool): void {
    this.connectionPool = connectionPool;
  }

  /**
   * Mark this instance as started in Firestore
   */
  private async markInstanceStartup(): Promise<void> {
    try {
      await this.firestore
        .collection("server_instances")
        .doc(this.instanceId)
        .set({
          instanceId: this.instanceId,
          startedAt: Timestamp.now(),
          status: "running",
          recoveryInProgress: false,
          pid: process.pid,
          hostname: process.env.HOSTNAME || "unknown",
        });

      this.logger.info(
        { instanceId: this.instanceId },
        "Server instance registered",
      );
    } catch (error: any) {
      this.logger.error(
        { error: error.message },
        "Failed to register instance",
      );
    }
  }

  /**
   * Recover all active sessions after server restart
   */
  async recoverActiveSessions(): Promise<void> {
    if (!this.options.autoReconnect) {
      this.logger.info("Auto-reconnect disabled, skipping session recovery");
      return;
    }

    if (this.isRecovering) {
      this.logger.warn("Recovery already in progress");
      return;
    }

    if (!this.connectionPool) {
      this.logger.error("ConnectionPool not set, cannot recover sessions");
      return;
    }

    this.isRecovering = true;

    try {
      this.logger.info("Starting session recovery after server restart");

      // Mark recovery in progress
      await this.firestore
        .collection("server_instances")
        .doc(this.instanceId)
        .update({
          recoveryInProgress: true,
          recoveryStartedAt: Timestamp.now(),
        });

      // Get all active sessions from before restart
      const activeSessions = await this.getActiveSessionsToRecover();

      if (activeSessions.length === 0) {
        this.logger.info("No active sessions to recover");
        return;
      }

      this.logger.info(
        { count: activeSessions.length },
        "Found active sessions to recover",
      );

      // Sort by priority countries
      const sortedSessions = this.prioritizeSessions(activeSessions);

      // Recover sessions in batches to avoid overload
      const batchSize = 5;
      for (let i = 0; i < sortedSessions.length; i += batchSize) {
        const batch = sortedSessions.slice(i, i + batchSize);
        await Promise.all(batch.map((session) => this.recoverSession(session)));

        // Delay between batches
        if (i + batchSize < sortedSessions.length) {
          await this.delay(this.options.reconnectDelay);
        }
      }

      this.logger.info(
        { recovered: sortedSessions.length },
        "Session recovery completed",
      );
    } catch (error: any) {
      this.logger.error({ error: error.message }, "Session recovery failed");
    } finally {
      this.isRecovering = false;

      // Mark recovery complete
      await this.firestore
        .collection("server_instances")
        .doc(this.instanceId)
        .update({
          recoveryInProgress: false,
          recoveryCompletedAt: Timestamp.now(),
        });
    }
  }

  /**
   * Get active sessions that need recovery
   */
  private async getActiveSessionsToRecover(): Promise<RecoverySession[]> {
    const sessions: RecoverySession[] = [];

    try {
      // Check for sessions that were active in the last 24 hours
      const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000);

      // Get WhatsApp phone numbers that were connected recently
      const phoneNumbersSnapshot = await this.firestore
        .collection("whatsapp_phone_numbers")
        .where("status", "==", "connected")
        .where("last_activity", ">=", Timestamp.fromDate(cutoffTime))
        .get();

      // Convert phone numbers to recovery sessions
      phoneNumbersSnapshot.forEach((doc) => {
        const data = doc.data();
        sessions.push({
          userId: data.user_id,
          phoneNumber: data.phone_number,
          proxyCountry: data.country_code || "us", // Use country from phone record
          lastConnected: data.last_activity?.toDate() || new Date(),
          status: "disconnected",
        });
      });

      // Also check for sessions without proxy (backwards compatibility)
      phoneNumbersSnapshot.forEach((doc) => {
        const data = doc.data();

        // If not already in sessions (no proxy assignment)
        if (
          !sessions.find(
            (s) =>
              s.userId === data.user_id && s.phoneNumber === data.phone_number,
          )
        ) {
          sessions.push({
            userId: data.user_id,
            phoneNumber: data.phone_number,
            proxyCountry:
              data.proxy_country ||
              this.detectCountryFromPhone(data.phone_number),
            lastConnected: data.last_activity.toDate(),
            status: "disconnected",
          });
        }
      });
    } catch (error: any) {
      this.logger.error(
        { error: error.message },
        "Failed to get active sessions",
      );
    }

    return sessions;
  }

  /**
   * Prioritize sessions by country
   */
  private prioritizeSessions(sessions: RecoverySession[]): RecoverySession[] {
    return sessions.sort((a, b) => {
      // Priority countries first
      const aPriority =
        this.options.priorityCountries?.indexOf(a.proxyCountry || "") ?? -1;
      const bPriority =
        this.options.priorityCountries?.indexOf(b.proxyCountry || "") ?? -1;

      if (aPriority !== -1 && bPriority === -1) return -1;
      if (aPriority === -1 && bPriority !== -1) return 1;
      if (aPriority !== -1 && bPriority !== -1) {
        return aPriority - bPriority;
      }

      // Then by last connected time (most recent first)
      return b.lastConnected.getTime() - a.lastConnected.getTime();
    });
  }

  /**
   * Recover a single session
   */
  private async recoverSession(session: RecoverySession): Promise<void> {
    const { userId, phoneNumber, proxyIp, proxyCountry } = session;

    this.logger.info(
      { userId, phoneNumber, proxyIp, proxyCountry },
      "Recovering session",
    );

    let attempts = 0;
    let recovered = false;

    while (attempts < this.options.maxReconnectAttempts && !recovered) {
      attempts++;

      try {
        // Step 1: Reactivate or get new proxy
        let proxy;

        if (proxyIp) {
          // Try to reactivate existing proxy
          proxy = await this.reactivateProxy(proxyIp, userId, phoneNumber);

          if (!proxy) {
            // Proxy no longer available, get new one for same country
            this.logger.info(
              { proxyIp, country: proxyCountry },
              "Original proxy unavailable, purchasing new one",
            );

            const result = await this.dynamicProxyService.assignProxy(
              userId,
              phoneNumber,
              proxyCountry || "us",
            );
            proxy = result.proxy;
          }
        } else {
          // No previous proxy, assign new one
          const result = await this.dynamicProxyService.assignProxy(
            userId,
            phoneNumber,
            proxyCountry || "us",
          );
          proxy = result.proxy;
        }

        // Step 2: Reconnect WhatsApp session
        const connected = await this.connectionPool!.addConnection(
          userId,
          phoneNumber,
          proxy.country,
          undefined, // countryCode
          true, // isRecovery flag
        );

        if (connected) {
          recovered = true;

          // Update recovery status
          await this.updateSessionStatus(userId, phoneNumber, "active");

          this.logger.info(
            { userId, phoneNumber, attempts, proxyIp: proxy.ip },
            "Session recovered successfully",
          );
        } else {
          throw new Error("Failed to establish WhatsApp connection");
        }
      } catch (error: any) {
        this.logger.error(
          {
            userId,
            phoneNumber,
            attempt: attempts,
            error: error.message,
          },
          "Session recovery attempt failed",
        );

        if (attempts < this.options.maxReconnectAttempts) {
          await this.delay(this.options.reconnectDelay * attempts); // Exponential backoff
        }
      }
    }

    if (!recovered) {
      // Mark session as failed
      await this.updateSessionStatus(userId, phoneNumber, "error");

      this.logger.error(
        { userId, phoneNumber, attempts },
        "Failed to recover session after all attempts",
      );
    }
  }

  /**
   * Reactivate an existing proxy (no longer supported - always purchase new)
   */
  private async reactivateProxy(
    _proxyIp: string,
    userId: string,
    phoneNumber: string,
  ): Promise<any | null> {
    // No proxy tracking - always purchase new proxies
    this.logger.debug(
      { userId, phoneNumber },
      "Proxy reactivation not supported in direct purchase/release model",
    );
    return null;
  }

  /**
   * Update session recovery status
   */
  private async updateSessionStatus(
    userId: string,
    phoneNumber: string,
    status: "active" | "disconnected" | "error",
  ): Promise<void> {
    try {
      const docId = `${userId}_${phoneNumber}`;
      await this.firestore.collection("session_recovery").doc(docId).set(
        {
          userId,
          phoneNumber,
          status,
          instanceId: this.instanceId,
          lastUpdated: Timestamp.now(),
        },
        { merge: true },
      );
    } catch (error: any) {
      this.logger.error(
        { error: error.message },
        "Failed to update session status",
      );
    }
  }

  /**
   * Detect country from phone number
   */
  private detectCountryFromPhone(phoneNumber: string): string {
    // Simple country detection based on prefix
    const countryPrefixes: Record<string, string> = {
      "1": "us", // USA/Canada
      "44": "gb", // UK
      "49": "de", // Germany
      "33": "fr", // France
      "31": "nl", // Netherlands
      "32": "be", // Belgium
      "91": "in", // India
      "86": "cn", // China
      "81": "jp", // Japan
      "82": "kr", // South Korea
      "61": "au", // Australia
      "64": "nz", // New Zealand
      "55": "br", // Brazil
      "52": "mx", // Mexico
    };

    const cleaned = phoneNumber.replace(/\D/g, "");

    for (const [prefix, country] of Object.entries(countryPrefixes)) {
      if (cleaned.startsWith(prefix)) {
        return country;
      }
    }

    return "us"; // Default
  }

  /**
   * Graceful shutdown - mark sessions appropriately
   */
  async shutdown(): Promise<void> {
    this.logger.info("Marking sessions for graceful shutdown");

    try {
      // Mark server instance as stopped
      const batch = this.firestore.batch();

      // Update server instance
      batch.update(
        this.firestore.collection("server_instances").doc(this.instanceId),
        {
          status: "stopped",
          stoppedAt: Timestamp.now(),
          gracefulShutdown: true,
        },
      );

      await batch.commit();

      this.logger.info("Sessions marked for graceful shutdown");
    } catch (error: any) {
      this.logger.error({ error: error.message }, "Failed to mark shutdown");
    }
  }

  /**
   * Cleanup old server instances
   */
  async cleanupOldInstances(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours

      const oldInstances = await this.firestore
        .collection("server_instances")
        .where("startedAt", "<", Timestamp.fromDate(cutoff))
        .get();

      const batch = this.firestore.batch();
      oldInstances.forEach((doc) => {
        batch.delete(doc.ref);
      });

      await batch.commit();

      if (oldInstances.size > 0) {
        this.logger.info(
          { count: oldInstances.size },
          "Cleaned up old server instances",
        );
      }
    } catch (error: any) {
      this.logger.error(
        { error: error.message },
        "Failed to cleanup old instances",
      );
    }
  }

  /**
   * Helper to delay execution
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
