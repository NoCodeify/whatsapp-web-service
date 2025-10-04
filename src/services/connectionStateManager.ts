import { Firestore } from "@google-cloud/firestore";
import * as admin from "firebase-admin";
import pino from "pino";
import { EventEmitter } from "events";

export interface ConnectionState {
  userId: string;
  phoneNumber: string;
  status: "connecting" | "connected" | "disconnected" | "failed" | "qr_pending";
  instanceUrl: string;
  createdAt: Date;
  lastActivity: Date;
  lastHeartbeat: Date;
  messageCount: number;
  sessionExists: boolean;
  qrScanned: boolean;
  syncCompleted: boolean;
  syncProgress?: {
    contacts: number;
    messages: number;
    startedAt: Date;
    completedAt?: Date;
  };
  errorCount: number;
  lastError?: string;
  metadata?: {
    proxyCountry?: string;
    proxyIp?: string;
    whatsappVersion?: string;
    platform?: string;
  };
}

export class ConnectionStateManager extends EventEmitter {
  private firestore: Firestore;
  private logger = pino({ name: "ConnectionStateManager" });
  private states: Map<string, ConnectionState> = new Map();
  private heartbeatTimers: Map<string, NodeJS.Timeout> = new Map();

  private readonly HEARTBEAT_INTERVAL = 30000; // 30 seconds

  constructor(firestore: Firestore) {
    super();
    this.firestore = firestore;
    this.startCleanupTask();
  }

  /**
   * Initialize connection state
   */
  async initializeState(
    userId: string,
    phoneNumber: string,
    instanceUrl: string,
  ): Promise<ConnectionState> {
    const key = this.getStateKey(userId, phoneNumber);

    const state: ConnectionState = {
      userId,
      phoneNumber,
      status: "connecting",
      instanceUrl,
      createdAt: new Date(),
      lastActivity: new Date(),
      lastHeartbeat: new Date(),
      messageCount: 0,
      sessionExists: false,
      qrScanned: false,
      syncCompleted: false,
      errorCount: 0,
    };

    // Store in memory
    this.states.set(key, state);

    // Store in Firestore
    await this.persistState(state);

    // Start heartbeat
    this.startHeartbeat(userId, phoneNumber);

    this.logger.info({ userId, phoneNumber }, "Connection state initialized");

    return state;
  }

  /**
   * Update connection state
   */
  async updateState(
    userId: string,
    phoneNumber: string,
    updates: Partial<ConnectionState>,
  ): Promise<ConnectionState | null> {
    const key = this.getStateKey(userId, phoneNumber);
    const state = this.states.get(key);

    if (!state) {
      this.logger.warn({ userId, phoneNumber }, "State not found for update");
      return null;
    }

    // Update state
    Object.assign(state, updates, {
      lastActivity: new Date(),
    });

    // Persist to Firestore
    await this.persistState(state);

    // Emit state change event
    this.emit("state-changed", {
      userId,
      phoneNumber,
      oldStatus: state.status,
      newStatus: updates.status || state.status,
      state,
    });

    return state;
  }

  /**
   * Get connection state
   */
  async getState(
    userId: string,
    phoneNumber: string,
  ): Promise<ConnectionState | null> {
    const key = this.getStateKey(userId, phoneNumber);

    // Check memory first
    let state = this.states.get(key);

    if (!state) {
      // Try to load from Firestore
      const loadedState = await this.loadState(userId, phoneNumber);

      if (loadedState) {
        state = loadedState;
        this.states.set(key, state);

        // Restart heartbeat if connection is active
        if (state.status === "connected") {
          this.startHeartbeat(userId, phoneNumber);
        }
      }
    }

    return state || null;
  }

  /**
   * Get all active connections
   */
  async getActiveConnections(): Promise<ConnectionState[]> {
    try {
      const states: ConnectionState[] = [];

      // Get all users
      const usersSnapshot = await this.firestore.collection("users").get();

      for (const userDoc of usersSnapshot.docs) {
        const userId = userDoc.id;

        // Get connected sessions for this user from unified phone_numbers collection
        const sessionsSnapshot = await userDoc.ref
          .collection("phone_numbers")
          .where("type", "==", "whatsapp_web")
          .where("whatsapp_web.status", "==", "connected")
          .get();

        for (const sessionDoc of sessionsSnapshot.docs) {
          const data = sessionDoc.data();
          const phoneNumber = data.phone_number;
          const whatsappData = data.whatsapp_web || {};

          if (!phoneNumber) continue;

          states.push({
            userId,
            phoneNumber,
            status: whatsappData.status || "disconnected",
            instanceUrl: whatsappData.instance_url || "",
            createdAt: data.created_at?.toDate() || new Date(),
            lastActivity: data.updated_at?.toDate() || new Date(),
            lastHeartbeat:
              whatsappData.last_heartbeat?.toDate() ||
              data.updated_at?.toDate() ||
              new Date(),
            messageCount: whatsappData.message_count || 0,
            sessionExists: whatsappData.session_exists !== false,
            qrScanned: whatsappData.qr_scanned || false,
            syncCompleted: whatsappData.sync_completed || false,
            errorCount: whatsappData.error_count || 0,
            lastError: whatsappData.last_error,
          } as ConnectionState);
        }
      }

      return states;
    } catch (error) {
      this.logger.error({ error }, "Failed to get active connections");
      return [];
    }
  }

  /**
   * Recover connections after restart
   */
  async recoverConnections(): Promise<ConnectionState[]> {
    this.logger.info("Recovering previous connections");

    try {
      const recovered: ConnectionState[] = [];

      // Get all users
      const usersSnapshot = await this.firestore.collection("users").get();

      for (const userDoc of usersSnapshot.docs) {
        const userId = userDoc.id;

        // Get all WhatsApp sessions for this user from unified phone_numbers collection
        const sessionsSnapshot = await userDoc.ref
          .collection("phone_numbers")
          .where("type", "==", "whatsapp_web")
          .get();

        for (const sessionDoc of sessionsSnapshot.docs) {
          const data = sessionDoc.data();
          const phoneNumber = data.phone_number;
          const whatsappData = data.whatsapp_web || {};

          if (!phoneNumber) continue;

          // Skip if explicitly logged out
          if (whatsappData.status === "logged_out") {
            this.logger.debug(
              {
                userId,
                phoneNumber,
                status: whatsappData.status,
              },
              "Skipping logged out session",
            );
            continue;
          }

          // Create state from session data
          const state: ConnectionState = {
            userId,
            phoneNumber,
            status: "connecting", // Mark as recovering
            instanceUrl: whatsappData.instance_url || "",
            createdAt: data.created_at?.toDate() || new Date(),
            lastActivity: data.updated_at?.toDate() || new Date(),
            lastHeartbeat: data.updated_at?.toDate() || new Date(),
            messageCount: 0,
            sessionExists: true, // Assume true since we're recovering
            qrScanned: whatsappData.status !== "qr_pending",
            syncCompleted: false,
            errorCount: 0,
          };

          // Store in memory
          const key = this.getStateKey(userId, phoneNumber);
          this.states.set(key, state);

          recovered.push(state);

          this.logger.info(
            {
              userId,
              phoneNumber,
              previousStatus: data.status,
            },
            "Recovered connection state from phone_numbers collection",
          );
        }
      }

      this.logger.info(
        {
          totalRecovered: recovered.length,
        },
        "Connection recovery scan complete",
      );

      return recovered;
    } catch (error) {
      this.logger.error({ error }, "Failed to recover connections");
      return [];
    }
  }

  /**
   * Mark connection as connected
   */
  async markConnected(userId: string, phoneNumber: string) {
    await this.updateState(userId, phoneNumber, {
      status: "connected",
      sessionExists: true,
      qrScanned: true,
      errorCount: 0,
    });
  }

  /**
   * Mark connection as disconnected
   */
  async markDisconnected(userId: string, phoneNumber: string, reason?: string) {
    const key = this.getStateKey(userId, phoneNumber);

    // Stop heartbeat
    this.stopHeartbeat(userId, phoneNumber);

    await this.updateState(userId, phoneNumber, {
      status: "disconnected",
      lastError: reason,
    });

    // Remove from memory after a delay
    setTimeout(() => {
      this.states.delete(key);
    }, 60000); // Keep in memory for 1 minute
  }

  /**
   * Mark connection as failed
   */
  async markFailed(userId: string, phoneNumber: string, error: string) {
    const state = await this.getState(userId, phoneNumber);

    if (state) {
      await this.updateState(userId, phoneNumber, {
        status: "failed",
        errorCount: state.errorCount + 1,
        lastError: error,
      });
    }

    // Stop heartbeat
    this.stopHeartbeat(userId, phoneNumber);
  }

  /**
   * Update sync progress
   */
  async updateSyncProgress(
    userId: string,
    phoneNumber: string,
    contacts: number,
    messages: number,
    completed: boolean = false,
  ) {
    const state = await this.getState(userId, phoneNumber);

    if (!state) return;

    const syncProgress = state.syncProgress || {
      contacts: 0,
      messages: 0,
      startedAt: new Date(),
    };

    syncProgress.contacts = contacts;
    syncProgress.messages = messages;

    if (completed) {
      syncProgress.completedAt = new Date();
    }

    await this.updateState(userId, phoneNumber, {
      syncProgress,
      syncCompleted: completed,
    });
  }

  /**
   * Start heartbeat for connection
   */
  private startHeartbeat(userId: string, phoneNumber: string) {
    const key = this.getStateKey(userId, phoneNumber);

    // Clear existing timer
    this.stopHeartbeat(userId, phoneNumber);

    // Start new heartbeat timer
    const timer = setInterval(async () => {
      const state = this.states.get(key);

      if (!state || state.status !== "connected") {
        this.stopHeartbeat(userId, phoneNumber);
        return;
      }

      // Update heartbeat
      state.lastHeartbeat = new Date();

      // Persist to Firestore
      await this.persistHeartbeat(userId, phoneNumber);

      this.logger.debug({ userId, phoneNumber }, "Heartbeat sent");
    }, this.HEARTBEAT_INTERVAL);

    this.heartbeatTimers.set(key, timer);
  }

  /**
   * Stop heartbeat for connection
   */
  private stopHeartbeat(userId: string, phoneNumber: string) {
    const key = this.getStateKey(userId, phoneNumber);
    const timer = this.heartbeatTimers.get(key);

    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(key);
      this.logger.debug({ userId, phoneNumber }, "Heartbeat stopped");
    }
  }

  /**
   * Persist state to Firestore
   */
  private async persistState(state: ConnectionState) {
    try {
      // Use the unified phone_numbers collection
      const phoneNumbersSnapshot = await this.firestore
        .collection("users")
        .doc(state.userId)
        .collection("phone_numbers")
        .where("phone_number", "==", state.phoneNumber)
        .where("type", "==", "whatsapp_web")
        .limit(1)
        .get();

      let ref;
      if (!phoneNumbersSnapshot.empty) {
        // Update existing phone number document
        ref = phoneNumbersSnapshot.docs[0].ref;
      } else {
        // Create new phone number document using phone number as ID (consistent with Cloud Function)
        ref = this.firestore
          .collection("users")
          .doc(state.userId)
          .collection("phone_numbers")
          .doc(state.phoneNumber);
      }

      const whatsappData: any = {
        status: state.status,
        instance_url: state.instanceUrl,
        session_exists: state.sessionExists,
        qr_scanned: state.qrScanned,
        sync_completed: state.syncCompleted,
        message_count: state.messageCount,
        error_count: state.errorCount,
        last_error: state.lastError,
        last_seen: admin.firestore.Timestamp.now(),
      };

      const firestoreData: any = {
        phone_number: state.phoneNumber,
        type: "whatsapp_web",
        status: "active",
        updated_at: admin.firestore.Timestamp.now(),
        last_activity: admin.firestore.Timestamp.now(),
        whatsapp_web: whatsappData,
      };

      // Only set created_at if this is a new document
      if (phoneNumbersSnapshot.empty) {
        firestoreData.created_at = admin.firestore.Timestamp.now();
      }

      // Add sync progress fields if available
      if (state.syncProgress) {
        whatsappData.sync_contacts_count = state.syncProgress.contacts;
        whatsappData.sync_messages_count = state.syncProgress.messages;
        whatsappData.sync_started_at = admin.firestore.Timestamp.fromDate(
          state.syncProgress.startedAt,
        );

        if (state.syncProgress.completedAt) {
          whatsappData.sync_completed_at = admin.firestore.Timestamp.fromDate(
            state.syncProgress.completedAt,
          );
        }

        // Add sync status based on progress
        if (state.syncCompleted) {
          whatsappData.sync_status = "completed";
        } else if (state.syncProgress.messages > 0) {
          whatsappData.sync_status = "importing_messages";
        } else if (state.syncProgress.contacts > 0) {
          whatsappData.sync_status = "importing_contacts";
        } else {
          whatsappData.sync_status = "started";
        }

        whatsappData.sync_last_update = admin.firestore.Timestamp.now();
      }

      // Update the whatsapp_web nested object
      firestoreData.whatsapp_web = whatsappData;

      await ref.set(firestoreData, { merge: true });
    } catch (error: any) {
      this.logger.error(
        {
          error,
          errorMessage: error?.message,
          errorStack: error?.stack,
          errorCode: error?.code,
          state,
          userId: state.userId,
          phoneNumber: state.phoneNumber,
        },
        "Failed to persist state",
      );
    }
  }

  /**
   * Persist heartbeat only
   */
  private async persistHeartbeat(userId: string, phoneNumber: string) {
    try {
      // Find the phone number document
      const phoneNumbersSnapshot = await this.firestore
        .collection("users")
        .doc(userId)
        .collection("phone_numbers")
        .where("phone_number", "==", phoneNumber)
        .where("type", "==", "whatsapp_web")
        .limit(1)
        .get();

      if (!phoneNumbersSnapshot.empty) {
        const ref = phoneNumbersSnapshot.docs[0].ref;
        await ref.update({
          "whatsapp_web.last_heartbeat": admin.firestore.Timestamp.now(),
          "whatsapp_web.last_seen": admin.firestore.Timestamp.now(),
          updated_at: admin.firestore.Timestamp.now(),
          last_activity: admin.firestore.Timestamp.now(),
        });
      }
    } catch (error: any) {
      this.logger.error(
        {
          error,
          errorMessage: error?.message,
          errorStack: error?.stack,
          errorCode: error?.code,
          userId,
          phoneNumber,
        },
        "Failed to persist heartbeat",
      );
    }
  }

  /**
   * Load state from Firestore
   */
  private async loadState(
    userId: string,
    phoneNumber: string,
  ): Promise<ConnectionState | null> {
    try {
      const phoneNumbersSnapshot = await this.firestore
        .collection("users")
        .doc(userId)
        .collection("phone_numbers")
        .where("phone_number", "==", phoneNumber)
        .where("type", "==", "whatsapp_web")
        .limit(1)
        .get();

      if (phoneNumbersSnapshot.empty) {
        return null;
      }

      const data = phoneNumbersSnapshot.docs[0].data();
      const whatsappData = data.whatsapp_web || {};

      return {
        userId,
        phoneNumber,
        status: whatsappData.status || "disconnected",
        instanceUrl: whatsappData.instance_url || "",
        createdAt: data.created_at?.toDate() || new Date(),
        lastActivity: data.updated_at?.toDate() || new Date(),
        lastHeartbeat:
          whatsappData.last_heartbeat?.toDate() ||
          whatsappData.last_seen?.toDate() ||
          data.updated_at?.toDate() ||
          new Date(),
        messageCount: whatsappData.message_count || 0,
        sessionExists: whatsappData.session_exists !== false,
        qrScanned:
          whatsappData.qr_scanned || whatsappData.status !== "qr_pending",
        syncCompleted: whatsappData.sync_completed || false,
        errorCount: whatsappData.error_count || 0,
        lastError: whatsappData.last_error,
        syncProgress: undefined,
      } as ConnectionState;
    } catch (error) {
      this.logger.error({ error, userId, phoneNumber }, "Failed to load state");
      return null;
    }
  }

  /**
   * Start cleanup task
   */
  private startCleanupTask() {
    // No longer doing time-based cleanup
    // Connections persist until explicitly logged out
    this.logger.info(
      "Stale connection cleanup disabled - connections persist until logout",
    );
  }

  /**
   * Get state key
   */
  private getStateKey(userId: string, phoneNumber: string): string {
    return `${userId}:${phoneNumber}`;
  }

  /**
   * Get connection metrics
   */
  async getMetrics() {
    const states = Array.from(this.states.values());

    return {
      total: states.length,
      connected: states.filter((s) => s.status === "connected").length,
      connecting: states.filter((s) => s.status === "connecting").length,
      disconnected: states.filter((s) => s.status === "disconnected").length,
      failed: states.filter((s) => s.status === "failed").length,
      qrPending: states.filter((s) => s.status === "qr_pending").length,
      synced: states.filter((s) => s.syncCompleted).length,
      totalMessages: states.reduce((sum, s) => sum + s.messageCount, 0),
    };
  }

  /**
   * Shutdown manager
   */
  async shutdown() {
    this.logger.info("Shutting down connection state manager");

    // Stop all heartbeats
    for (const timer of this.heartbeatTimers.values()) {
      clearInterval(timer);
    }
    this.heartbeatTimers.clear();

    // Persist final states
    for (const state of this.states.values()) {
      await this.persistState(state);
    }

    this.logger.info("Connection state manager shutdown complete");
  }
}
