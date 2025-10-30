import { Firestore } from "@google-cloud/firestore";
import * as admin from "firebase-admin";
import pino from "pino";
import { EventEmitter } from "events";

export interface ConnectionState {
  userId: string;
  phoneNumber: string;
  status:
    | "connecting"
    | "connected"
    | "disconnected"
    | "failed"
    | "qr_pending"
    | "importing" // Generic import state
    | "importing_contacts" // Importing contacts phase
    | "importing_messages"; // Importing messages phase
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
   * Update in-memory status only (without persisting to Firestore)
   * Used to keep in-memory state synchronized when status is updated elsewhere
   */
  updateInMemoryStatus(
    userId: string,
    phoneNumber: string,
    status: ConnectionState["status"],
  ): void {
    const key = this.getStateKey(userId, phoneNumber);
    const state = this.states.get(key);

    if (state) {
      state.status = status;
      state.lastActivity = new Date();

      this.logger.debug(
        { userId, phoneNumber, status },
        "Updated in-memory status without Firestore write",
      );
    }
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
            status: whatsappData.status || "connecting", // Use actual status from database
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
   * Persist state to Firestore with retry logic
   */
  private async persistState(state: ConnectionState) {
    return this.persistStateWithRetry(state, 1);
  }

  /**
   * Persist state to Firestore with exponential backoff retry
   */
  private async persistStateWithRetry(
    state: ConnectionState,
    attempt: number,
  ): Promise<void> {
    const maxAttempts = 3;
    const retryDelays = [1000, 2000, 4000]; // 1s, 2s, 4s

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

      // Handle missing document
      if (phoneNumbersSnapshot.empty) {
        // For disconnected states, it's OK if document was deleted (user logged out)
        if (state.status === "disconnected" || state.status === "failed") {
          this.logger.info(
            { userId: state.userId, phoneNumber: state.phoneNumber, status: state.status },
            "Phone number document doesn't exist for disconnected state - user likely logged out",
          );
          return;
        }

        // For active states (connecting, connected, qr_pending), verify document truly doesn't exist
        // by doing a direct check rather than trusting the query result
        const verifySnapshot = await this.firestore
          .collection("users")
          .doc(state.userId)
          .collection("phone_numbers")
          .where("phone_number", "==", state.phoneNumber)
          .get();

        if (verifySnapshot.empty) {
          // Document truly doesn't exist for an active connection
          // This indicates a synchronization issue - log at ERROR level
          this.logger.error(
            {
              userId: state.userId,
              phoneNumber: state.phoneNumber,
              status: state.status,
              attempt,
            },
            "CRITICAL: Phone number document missing for active connection - status update SKIPPED. This will cause 'no connection' errors!",
          );

          // Schedule a retry for active connections
          if (attempt < maxAttempts) {
            const delay = retryDelays[attempt - 1];
            this.logger.warn(
              { userId: state.userId, phoneNumber: state.phoneNumber, attempt, delay },
              `Scheduling retry ${attempt}/${maxAttempts} to persist state`,
            );

            await new Promise((resolve) => setTimeout(resolve, delay));
            return this.persistStateWithRetry(state, attempt + 1);
          } else {
            this.logger.error(
              { userId: state.userId, phoneNumber: state.phoneNumber },
              "Max retry attempts reached - state persistence FAILED. Manual intervention required!",
            );
          }

          return;
        }

        // Query might have returned empty due to eventual consistency
        // Use the document from verification
        const ref = verifySnapshot.docs.find((doc) => doc.data().type === "whatsapp_web")?.ref;

        if (!ref) {
          this.logger.error(
            { userId: state.userId, phoneNumber: state.phoneNumber },
            "Phone number document exists but type is not whatsapp_web",
          );
          return;
        }

        // Proceed with update using the verified reference
        await this.performStateUpdate(ref, state);
        return;
      }

      // Update existing document
      const ref = phoneNumbersSnapshot.docs[0].ref;
      await this.performStateUpdate(ref, state);
    } catch (error: any) {
      // Determine if error is retryable
      const isRetryable =
        error?.code === "UNAVAILABLE" ||
        error?.code === "DEADLINE_EXCEEDED" ||
        error?.message?.includes("timeout") ||
        error?.message?.includes("ECONNRESET");

      if (isRetryable && attempt < maxAttempts) {
        const delay = retryDelays[attempt - 1];
        this.logger.warn(
          {
            error: error?.message,
            errorCode: error?.code,
            userId: state.userId,
            phoneNumber: state.phoneNumber,
            attempt,
            delay,
          },
          `Retryable error during persistState, scheduling retry ${attempt}/${maxAttempts}`,
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.persistStateWithRetry(state, attempt + 1);
      }

      // Non-retryable error or max attempts reached
      this.logger.error(
        {
          error,
          errorMessage: error?.message,
          errorStack: error?.stack,
          errorCode: error?.code,
          state,
          userId: state.userId,
          phoneNumber: state.phoneNumber,
          attempt,
          isRetryable,
          maxAttemptsReached: attempt >= maxAttempts,
        },
        "CRITICAL: Failed to persist state after all retries - this WILL cause synchronization issues!",
      );

      // Emit event for monitoring/alerting
      this.emit("persist-failed", {
        userId: state.userId,
        phoneNumber: state.phoneNumber,
        status: state.status,
        error: error?.message,
        attempts: attempt,
      });
    }
  }

  /**
   * Perform the actual Firestore update
   */
  private async performStateUpdate(
    ref: admin.firestore.DocumentReference,
    state: ConnectionState,
  ): Promise<void> {
    // Prepare update data using nested field updates to avoid overwriting other fields
    // Use dot notation (e.g., "whatsapp_web.status") instead of object replacement
    const updateData: any = {
      phone_number: state.phoneNumber,
      type: "whatsapp_web",
      status: "active",
      updated_at: admin.firestore.Timestamp.now(),
      last_activity: admin.firestore.Timestamp.now(),
      // Use nested field updates instead of object replacement
      "whatsapp_web.status": state.status, // Use status as-is from ConnectionPool (single source of truth)
      "whatsapp_web.instance_url": state.instanceUrl,
      "whatsapp_web.session_exists": state.sessionExists,
      "whatsapp_web.qr_scanned": state.qrScanned,
      "whatsapp_web.sync_completed": state.syncCompleted,
      "whatsapp_web.message_count": state.messageCount,
      "whatsapp_web.error_count": state.errorCount,
      "whatsapp_web.last_error": state.lastError ?? null,
      "whatsapp_web.last_seen": admin.firestore.Timestamp.now(),
    };

    // Add sync progress fields if available
    if (state.syncProgress) {
      updateData["whatsapp_web.sync_contacts_count"] =
        state.syncProgress.contacts;
      updateData["whatsapp_web.sync_messages_count"] =
        state.syncProgress.messages;
      updateData["whatsapp_web.sync_started_at"] =
        admin.firestore.Timestamp.fromDate(state.syncProgress.startedAt);

      if (state.syncProgress.completedAt) {
        updateData["whatsapp_web.sync_completed_at"] =
          admin.firestore.Timestamp.fromDate(state.syncProgress.completedAt);
      }

      // Add sync status based on progress
      if (state.syncCompleted) {
        updateData["whatsapp_web.sync_status"] = "completed";
      } else if (state.syncProgress.messages > 0) {
        updateData["whatsapp_web.sync_status"] = "importing_messages";
      } else if (state.syncProgress.contacts > 0) {
        updateData["whatsapp_web.sync_status"] = "importing_contacts";
      } else {
        updateData["whatsapp_web.sync_status"] = "started";
      }

      updateData["whatsapp_web.sync_last_update"] =
        admin.firestore.Timestamp.now();
    }

    // Add metadata fields if available
    if (state.metadata) {
      if (state.metadata.proxyCountry) {
        updateData["whatsapp_web.proxy_country"] = state.metadata.proxyCountry;
      }
      if (state.metadata.proxyIp) {
        updateData["whatsapp_web.proxy_ip"] = state.metadata.proxyIp;
      }
      if (state.metadata.whatsappVersion) {
        updateData["whatsapp_web.whatsapp_version"] =
          state.metadata.whatsappVersion;
      }
      if (state.metadata.platform) {
        updateData["whatsapp_web.platform"] = state.metadata.platform;
      }
    }

    // Also update whatsapp_web_usage field for frontend compatibility
    // Frontend expects this field to show sync progress in the QR modal
    if (state.syncProgress) {
      updateData.whatsapp_web_usage = {
        contacts_synced: state.syncProgress.contacts,
        messages_synced: state.syncProgress.messages,
        last_sync: admin.firestore.Timestamp.now(),
      };
    }

    // Use .update() to only modify existing documents (won't create new ones)
    await ref.update(updateData);

    this.logger.debug(
      {
        userId: state.userId,
        phoneNumber: state.phoneNumber,
        status: state.status,
      },
      "State persisted successfully to Firestore",
    );
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

      // Load sync progress from Firestore if available
      let syncProgress: ConnectionState["syncProgress"] = undefined;
      if (
        whatsappData.sync_contacts_count ||
        whatsappData.sync_messages_count ||
        whatsappData.sync_started_at
      ) {
        syncProgress = {
          contacts: whatsappData.sync_contacts_count || 0,
          messages: whatsappData.sync_messages_count || 0,
          startedAt: whatsappData.sync_started_at?.toDate() || new Date(),
          completedAt: whatsappData.sync_completed_at?.toDate(),
        };
      }

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
        syncProgress,
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
