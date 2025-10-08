import { Firestore, Timestamp } from "@google-cloud/firestore";
import pino from "pino";
import { ConnectionPool } from "../core/ConnectionPool";

export interface RecoverySession {
  userId: string;
  phoneNumber: string;
  proxyIp?: string;
  proxyCountry?: string;
  phoneCountry?: string;
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
  private connectionPool?: ConnectionPool;
  private instanceCoordinator?: any; // InstanceCoordinator - avoiding circular imports
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

  constructor(firestore: Firestore, instanceId?: string) {
    this.firestore = firestore;
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
   * Set the instance coordinator reference
   */
  setInstanceCoordinator(instanceCoordinator: any): void {
    this.instanceCoordinator = instanceCoordinator;
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
   * Get active sessions that need recovery from unified phone_numbers collection
   */
  private async getActiveSessionsToRecover(): Promise<RecoverySession[]> {
    const sessions: RecoverySession[] = [];

    try {
      this.logger.info(
        "Searching for WhatsApp Web sessions to recover using collectionGroup query",
      );

      // Use collectionGroup to query ALL phone_numbers subcollections at once
      // This is dramatically more efficient than looping through users (1 read vs N reads)
      const phoneNumbersSnapshot = await this.firestore
        .collectionGroup("phone_numbers")
        .where("type", "==", "whatsapp_web")
        .get();

      phoneNumbersSnapshot.forEach((phoneDoc) => {
        const data = phoneDoc.data();
        const phoneNumber = phoneDoc.id;
        // Extract userId from document path: users/{userId}/phone_numbers/{phoneNumber}
        const userId = phoneDoc.ref.parent.parent?.id;

        if (!userId) {
          this.logger.warn(
            { phoneNumber },
            "Could not extract userId from document path",
          );
          return;
        }

        this.logger.debug(
          {
            userId,
            phoneNumber,
            status: data.whatsapp_web?.status,
            whatsapp_web: data.whatsapp_web
              ? Object.keys(data.whatsapp_web)
              : "undefined",
          },
          "Found WhatsApp Web phone number record",
        );

        // Check if session has valid data for recovery
        const hasSessionData =
          data.whatsapp_web?.session_exists || data.whatsapp_web?.qr_scanned;

        if (!hasSessionData) {
          this.logger.debug(
            { userId, phoneNumber },
            "Skipping session recovery - no valid session data or QR scan",
          );
          return;
        }

        // Include sessions that might need recovery based on status
        const recoveryStatuses = [
          "connected",
          "disconnected",
          "failed",
          "initializing",
          "pending_recovery", // Sessions marked for recovery during graceful shutdown
        ];

        // Read from nested whatsapp_web.status (single source of truth)
        const sessionStatus = data.whatsapp_web?.status;

        if (recoveryStatuses.includes(sessionStatus)) {
          sessions.push({
            userId,
            phoneNumber,
            phoneCountry: data.whatsapp_web?.phone_country || data.country_code,
            proxyCountry: data.whatsapp_web?.proxy_country,
            lastConnected:
              data.whatsapp_web?.last_updated?.toDate() ||
              data.updated_at?.toDate() ||
              new Date(),
            status: "disconnected",
          });

          this.logger.debug(
            { userId, phoneNumber, status: sessionStatus },
            "Added session for recovery",
          );
        } else {
          this.logger.debug(
            { userId, phoneNumber, status: sessionStatus },
            "Skipping session - status not eligible for recovery",
          );
        }
      });

      if (sessions.length > 0) {
        this.logger.info(
          { found: sessions.length },
          "Found sessions in unified phone_numbers collection for recovery",
        );
      } else {
        this.logger.info(
          "No sessions found in unified phone_numbers collection",
        );
      }
    } catch (error: any) {
      this.logger.error(
        {
          error: error.message,
          code: error.code,
          details: error.details,
          // Firestore includes index creation URL in the full error
          fullError: error.toString(),
        },
        "Failed to get active sessions for recovery - may need Firestore composite index",
      );

      // Log the full error to console to see the index creation link
      console.error("=== Firestore Index Error ===");
      console.error("Full error object:", error);
      console.error(
        "If this is a missing index error, check the error above for the index creation URL",
      );
      console.error("=============================");
    }

    return sessions;
  }

  /**
   * Prioritize sessions by country
   */
  private prioritizeSessions(sessions: RecoverySession[]): RecoverySession[] {
    return sessions.sort((a, b) => {
      // Priority countries first (based on phone's country)
      const aPriority =
        this.options.priorityCountries?.indexOf(a.phoneCountry || "") ?? -1;
      const bPriority =
        this.options.priorityCountries?.indexOf(b.phoneCountry || "") ?? -1;

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
    const { userId, phoneNumber, proxyIp, phoneCountry, proxyCountry } =
      session;

    // Check with instance coordinator to prevent duplicate recovery
    if (this.instanceCoordinator) {
      const shouldHandle = await this.instanceCoordinator.shouldHandleSession(
        userId,
        phoneNumber,
      );

      if (!shouldHandle) {
        this.logger.info(
          { userId, phoneNumber, instanceId: this.instanceId },
          "Session is being handled by another instance, skipping recovery",
        );
        return;
      }
    }

    this.logger.info(
      { userId, phoneNumber, proxyIp, phoneCountry, proxyCountry },
      "Recovering session",
    );

    let attempts = 0;
    let recovered = false;

    while (attempts < this.options.maxReconnectAttempts && !recovered) {
      attempts++;

      try {
        // ProxyManager will handle proxy assignment through getProxyConfig
        // This ensures activeProxies Map is populated for proper cleanup
        // Extract country code from phone number (e.g., "31" from "+31...")
        const countryCode = phoneNumber.match(/^\+(\d{1,3})/)?.[1];

        const connected = await this.connectionPool!.addConnection(
          userId,
          phoneNumber,
          phoneCountry, // Pass the actual detected country (e.g., "nl" for Dutch numbers)
          countryCode, // Pass the country code (e.g., "31" for Netherlands)
          false, // Let ProxyManager handle proxy purchase to populate activeProxies
        );

        if (connected) {
          recovered = true;

          // Update recovery status across all collections
          await this.updateAllSessionStatuses(userId, phoneNumber, "active");

          // Update session activity in instance coordinator
          if (this.instanceCoordinator) {
            await this.instanceCoordinator.updateSessionActivity(
              userId,
              phoneNumber,
            );
          }

          this.logger.info(
            { userId, phoneNumber, attempts },
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
      // Mark session as failed across all collections
      await this.updateAllSessionStatuses(userId, phoneNumber, "error");

      // Release session ownership since recovery failed
      if (this.instanceCoordinator) {
        await this.instanceCoordinator.releaseSessionOwnership(
          userId,
          phoneNumber,
        );
      }

      this.logger.error(
        { userId, phoneNumber, attempts },
        "Failed to recover session after all attempts",
      );
    }
  }

  /**
   * Update session status in the unified phone_numbers collection
   */
  private async updateAllSessionStatuses(
    userId: string,
    phoneNumber: string,
    status: string,
  ): Promise<void> {
    try {
      // Map recovery service status to collection status
      let firestoreStatus: string = status;
      if (status === "active") {
        firestoreStatus = "connected";
      } else if (status === "error") {
        firestoreStatus = "failed";
      } else if (status === "disconnected") {
        firestoreStatus = "disconnected";
      }

      // Update unified phone_numbers collection
      const phoneNumberRef = this.firestore
        .collection("users")
        .doc(userId)
        .collection("phone_numbers")
        .doc(phoneNumber);

      // Get current data to preserve existing fields
      const phoneDoc = await phoneNumberRef.get();

      // Don't recreate deleted documents - respect user/system deletions
      if (!phoneDoc.exists) {
        this.logger.info(
          { userId, phoneNumber },
          "Phone number document doesn't exist (was deleted), skipping status update to respect deletion",
        );
        return;
      }

      const currentData = phoneDoc.data() || {};

      // Update with new status and recovery information in nested structure
      await phoneNumberRef.update({
        whatsapp_web: {
          ...(currentData.whatsapp_web || {}),
          status: firestoreStatus, // Single source of truth for status
          last_activity: Timestamp.now(),
          last_updated: Timestamp.now(),
          instance_id: this.instanceId,
          recovery_attempted: true,
          recovery_attempt_time: Timestamp.now(),
        },
        updated_at: Timestamp.now(),
      });

      this.logger.info(
        { userId, phoneNumber, status: firestoreStatus },
        "Updated session status in unified phone_numbers collection",
      );
    } catch (error: any) {
      this.logger.error(
        { error: error.message, userId, phoneNumber, status },
        "Failed to update session status in unified collection",
      );
    }
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

      // Clean up very old sessions (regardless of status) from users subcollection
      const staleSessions = await this.firestore
        .collectionGroup("phone_numbers")
        .where("type", "==", "whatsapp_web")
        .where(
          "whatsapp_web.last_activity",
          "<",
          Timestamp.fromDate(staleThreshold),
        )
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

      // Clean up failed sessions older than 24 hours from users subcollection
      const failedSessions = await this.firestore
        .collectionGroup("phone_numbers")
        .where("type", "==", "whatsapp_web")
        .where("whatsapp_web.status", "==", "failed")
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
        .collectionGroup("phone_numbers")
        .where("type", "==", "whatsapp_web")
        .where("whatsapp_web.status", "==", "pending_recovery")
        .where(
          "whatsapp_web.last_activity",
          "<",
          Timestamp.fromDate(new Date(now.getTime() - 6 * 60 * 60 * 1000)),
        )
        .get();

      const batch3 = this.firestore.batch();
      let markedAsFailed = 0;
      let preservedForRecovery = 0;

      oldPendingSessions.forEach((doc) => {
        const data = doc.data();

        // Only mark as failed if session is truly unrecoverable
        if (!data.session_exists && !data.qr_scanned) {
          batch3.update(doc.ref, {
            "whatsapp_web.status": "failed",
            cleanup_reason: "pending_recovery_timeout_no_session_data",
            updated_at: Timestamp.now(),
          });
          markedAsFailed++;
        } else {
          // Keep as pending_recovery if session data exists and refresh activity
          batch3.update(doc.ref, {
            "whatsapp_web.last_activity": Timestamp.now(), // Update activity to prevent future cleanup
            cleanup_reason: "preserved_has_session_data",
            updated_at: Timestamp.now(),
          });
          preservedForRecovery++;
          // Extract userId from parent document path
          const userId = doc.ref.parent.parent?.id;
          this.logger.info(
            { userId, phoneNumber: data.phone_number },
            "Preserved pending_recovery session with valid data for recovery",
          );
        }
        cleanupCount++;
      });

      if (oldPendingSessions.size > 0) {
        await batch3.commit();
        this.logger.info(
          {
            total: oldPendingSessions.size,
            markedAsFailed,
            preservedForRecovery,
          },
          "Processed old pending_recovery sessions",
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
