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

      // Clean up stale sessions before recovery
      await this.cleanupStaleSessions();

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
      // Check for sessions that need recovery (either pending_recovery from shutdown or connected)
      const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000);

      // Get sessions that need recovery from main tracking collection
      const recoverySessionsSnapshot = await this.firestore
        .collection("whatsapp_phone_numbers")
        .where("status", "in", ["pending_recovery", "connected"])
        .where("last_activity", ">=", Timestamp.fromDate(cutoffTime))
        .get();

      recoverySessionsSnapshot.forEach((doc) => {
        const data = doc.data();
        sessions.push({
          userId: data.user_id,
          phoneNumber: data.phone_number,
          proxyCountry: data.proxy_country || data.country_code || "us",
          lastConnected: data.last_activity?.toDate() || new Date(),
          status: "disconnected",
        });
      });

      this.logger.info(
        { found: sessions.length },
        "Found sessions in whatsapp_phone_numbers collection for recovery"
      );

      // Fallback: Check users subcollection for backwards compatibility
      if (sessions.length === 0) {
        this.logger.info("No sessions found in main collection, checking users subcollections");

        // This is a more expensive query, so only use as fallback
        const usersSnapshot = await this.firestore.collection("users").get();

        for (const userDoc of usersSnapshot.docs) {
          const userId = userDoc.id;

          const phoneNumbersSnapshot = await this.firestore
            .collection("users")
            .doc(userId)
            .collection("phone_numbers")
            .where("whatsapp_web_status", "in", ["connected", "initializing"])
            .where("updated_at", ">=", Timestamp.fromDate(cutoffTime))
            .get();

          phoneNumbersSnapshot.forEach((phoneDoc) => {
            const data = phoneDoc.data();
            if (data.type === "whatsapp_web") {
              sessions.push({
                userId,
                phoneNumber: data.phone_number,
                proxyCountry: data.country_code || this.detectCountryFromPhone(data.phone_number),
                lastConnected: data.updated_at?.toDate() || new Date(),
                status: "disconnected",
              });
            }
          });
        }

        this.logger.info(
          { found: sessions.length },
          "Found sessions in users subcollection fallback"
        );
      }

    } catch (error: any) {
      this.logger.error(
        { error: error.message },
        "Failed to get active sessions for recovery",
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
   * Update session recovery status in whatsapp_phone_numbers collection
   */
  private async updateSessionStatus(
    userId: string,
    phoneNumber: string,
    status: "active" | "disconnected" | "error",
  ): Promise<void> {
    try {
      const docId = `${userId}_${phoneNumber}`;

      // Map recovery service status to collection status
      let firestoreStatus: string = status;
      if (status === "active") {
        firestoreStatus = "connected";
      } else if (status === "error") {
        firestoreStatus = "failed";
      } else if (status === "disconnected") {
        firestoreStatus = "disconnected";
      }

      // Update in main tracking collection
      await this.firestore.collection("whatsapp_phone_numbers").doc(docId).update({
        status: firestoreStatus,
        instance_id: this.instanceId,
        last_activity: Timestamp.now(),
        updated_at: Timestamp.now(),
        recovery_attempted: true,
        recovery_attempt_time: Timestamp.now(),
      });

      this.logger.info(
        { userId, phoneNumber, status: firestoreStatus },
        "Updated session recovery status in whatsapp_phone_numbers collection"
      );

      // Also maintain backwards compatibility with session_recovery collection
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
        { error: error.message, userId, phoneNumber, status },
        "Failed to update session recovery status",
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
   * Cleanup stale and failed sessions
   */
  async cleanupStaleSessions(): Promise<void> {
    try {
      const now = new Date();
      const staleThreshold = new Date(now.getTime() - 72 * 60 * 60 * 1000); // 72 hours
      const failedThreshold = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 24 hours

      let cleanupCount = 0;

      // Clean up very old sessions (regardless of status)
      const staleSessions = await this.firestore
        .collection("whatsapp_phone_numbers")
        .where("last_activity", "<", Timestamp.fromDate(staleThreshold))
        .get();

      const batch1 = this.firestore.batch();
      staleSessions.forEach((doc) => {
        batch1.delete(doc.ref);
        cleanupCount++;
      });

      if (staleSessions.size > 0) {
        await batch1.commit();
        this.logger.info(
          { count: staleSessions.size },
          "Cleaned up stale sessions older than 72 hours",
        );
      }

      // Clean up failed sessions older than 24 hours
      const failedSessions = await this.firestore
        .collection("whatsapp_phone_numbers")
        .where("status", "==", "failed")
        .where("updated_at", "<", Timestamp.fromDate(failedThreshold))
        .get();

      const batch2 = this.firestore.batch();
      failedSessions.forEach((doc) => {
        batch2.delete(doc.ref);
        cleanupCount++;
      });

      if (failedSessions.size > 0) {
        await batch2.commit();
        this.logger.info(
          { count: failedSessions.size },
          "Cleaned up failed sessions older than 24 hours",
        );
      }

      // Clean up pending_recovery sessions that are older than 6 hours (likely from failed deployments)
      const oldPendingSessions = await this.firestore
        .collection("whatsapp_phone_numbers")
        .where("status", "==", "pending_recovery")
        .where("last_activity", "<", Timestamp.fromDate(new Date(now.getTime() - 6 * 60 * 60 * 1000)))
        .get();

      const batch3 = this.firestore.batch();
      oldPendingSessions.forEach((doc) => {
        batch3.update(doc.ref, {
          status: "failed",
          cleanup_reason: "pending_recovery_timeout",
          updated_at: Timestamp.now(),
        });
        cleanupCount++;
      });

      if (oldPendingSessions.size > 0) {
        await batch3.commit();
        this.logger.info(
          { count: oldPendingSessions.size },
          "Marked old pending_recovery sessions as failed",
        );
      }

      if (cleanupCount > 0) {
        this.logger.info(
          { totalCleaned: cleanupCount },
          "Session cleanup completed",
        );
      }

    } catch (error: any) {
      this.logger.error(
        { error: error.message },
        "Failed to cleanup stale sessions",
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
