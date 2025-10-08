import {
  WASocket,
  DisconnectReason,
  ConnectionState,
  WAMessageContent,
  WAMessageKey,
  proto,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { EventEmitter } from "events";
import * as fs from "fs";
import { ProxyManager } from "./ProxyManager";
import { SessionManager } from "./SessionManager";
import { Firestore } from "@google-cloud/firestore";
import { PubSub } from "@google-cloud/pubsub";
import { ConnectionStateManager } from "../services/connectionStateManager";
import { MediaService } from "../services/MediaService";
import { CloudRunWebSocketManager } from "../services/CloudRunWebSocketManager";
import { ErrorHandler } from "../services/ErrorHandler";
import { InstanceCoordinator } from "../services/InstanceCoordinator";
import { formatPhoneNumberSafe, formatWhatsAppJid } from "../utils/phoneNumber";
import * as admin from "firebase-admin";
import { DocumentReference } from "@google-cloud/firestore";

export interface WhatsAppConnection {
  userId: string;
  phoneNumber: string;
  socket: WASocket;
  state: ConnectionState;
  qrCode?: string;
  qrTimeout?: NodeJS.Timeout;
  hasConnectedSuccessfully?: boolean;
  proxyCountry?: string;
  createdAt: Date;
  lastActivity: Date;
  messageCount: number;
  proxySessionId?: string;
  instanceUrl: string;
  proxyReleased?: boolean; // Track if proxy was released after successful connection
  isRecovery?: boolean; // Track if this is a recovery connection (redeployment)
  syncCompleted?: boolean; // Track if initial history sync has completed
  handshakeCompleted?: boolean; // Track if initial QR pairing handshake has completed (before first disconnect code 515)
}

export interface ConnectionPoolConfig {
  maxConnections: number;
  healthCheckInterval: number;
  sessionCleanupInterval: number;
  instanceUrl: string;
}

export class ConnectionPool extends EventEmitter {
  private connections: Map<string, WhatsAppConnection> = new Map();
  private logger = pino({ name: "ConnectionPool" });
  private proxyManager: ProxyManager;
  private sessionManager: SessionManager;
  private firestore: Firestore;
  private pubsub: PubSub;
  private connectionStateManager?: ConnectionStateManager;
  private mediaService: MediaService;
  private wsManager: CloudRunWebSocketManager;
  private errorHandler: ErrorHandler;
  private instanceCoordinator: InstanceCoordinator;
  private healthCheckTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private isShuttingDown: boolean = false;
  private importListRefs: Map<string, DocumentReference> = new Map(); // Store import list refs per user
  private pendingChatMetadata: Map<string, any> = new Map(); // Store chat metadata for contacts to be created
  private syncedContactInfo: Map<
    string,
    { name?: string; notify?: string; verifiedName?: string }
  > = new Map(); // Store contact info from contacts.upsert
  private sentMessageIds: Map<string, Date> = new Map(); // Track API-sent message IDs
  private processedContactsCache: Map<string, Set<string>> = new Map(); // Session-based contact deduplication

  private readonly config: ConnectionPoolConfig = {
    maxConnections: parseInt(process.env.MAX_CONNECTIONS || "50"),
    healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL || "30000"),
    sessionCleanupInterval: parseInt(
      process.env.SESSION_CLEANUP_INTERVAL || "3600000",
    ),
    instanceUrl:
      process.env.INSTANCE_URL ||
      `http://localhost:${process.env.PORT || 8080}`,
  };

  constructor(
    proxyManager: ProxyManager,
    sessionManager: SessionManager,
    firestore: Firestore,
    pubsub: PubSub,
    connectionStateManager?: ConnectionStateManager,
    wsManager?: any,
    errorHandler?: any,
    instanceCoordinator?: any,
  ) {
    super();
    this.proxyManager = proxyManager;
    this.sessionManager = sessionManager;
    this.firestore = firestore;
    this.pubsub = pubsub;
    this.connectionStateManager = connectionStateManager;
    this.mediaService = new MediaService();

    // Use provided services or create new ones (for backwards compatibility)
    this.wsManager = wsManager || new CloudRunWebSocketManager();
    this.errorHandler = errorHandler || new ErrorHandler();
    this.instanceCoordinator =
      instanceCoordinator || new InstanceCoordinator(firestore);

    // Set up WebSocket manager event listeners
    this.setupWebSocketManagerListeners();

    // Set up error handler event listeners
    this.setupErrorHandlerListeners();

    // Set up instance coordinator event listeners
    this.setupInstanceCoordinatorListeners();

    // Start instance coordinator
    this.instanceCoordinator.start().catch((error) => {
      this.logger.error({ error }, "Failed to start instance coordinator");
    });

    this.startHealthCheck();
    this.startCleanup();
  }

  /**
   * Setup WebSocket manager event listeners
   */
  private setupWebSocketManagerListeners(): void {
    this.wsManager.on(
      "connection-error",
      async ({ connectionId, error, consecutiveFailures, shouldReconnect }) => {
        // Parse connection ID to get userId and phoneNumber
        const [userId, phoneNumber] = connectionId.split(":");

        this.logger.warn(
          { userId, phoneNumber, consecutiveFailures, error: error.message },
          "WebSocket connection error detected",
        );

        if (shouldReconnect) {
          this.logger.info(
            { userId, phoneNumber },
            "WebSocket manager triggering reconnection",
          );

          // Remove the current connection to trigger reconnection
          await this.removeConnection(userId, phoneNumber);

          // Attempt reconnection after a short delay
          setTimeout(async () => {
            try {
              // Get stored country from database
              const storedCountry = await this.getStoredCountry(
                userId,
                phoneNumber,
              );
              await this.addConnection(
                userId,
                phoneNumber,
                storedCountry, // Use stored country from DB
              );
            } catch (reconnectError) {
              this.logger.error(
                { userId, phoneNumber, error: reconnectError },
                "WebSocket manager reconnection failed",
              );
            }
          }, 5000);
        }
      },
    );
  }

  /**
   * Setup error handler event listeners
   */
  private setupErrorHandlerListeners(): void {
    // Handle WebSocket recovery requests
    this.errorHandler.on(
      "websocket-recovery-needed",
      async ({ connectionId, userId, phoneNumber }) => {
        this.logger.info(
          { connectionId, userId, phoneNumber },
          "WebSocket recovery requested",
        );

        if (userId && phoneNumber) {
          try {
            // Get stored country from database
            const storedCountry = await this.getStoredCountry(
              userId,
              phoneNumber,
            );

            // Attempt to reconnect with retry logic
            await this.errorHandler.executeWithRetry(
              () =>
                this.addConnection(
                  userId,
                  phoneNumber,
                  storedCountry, // Use stored country from DB
                ),
              {
                userId,
                phoneNumber,
                connectionId,
                operation: "websocket-recovery",
                timestamp: new Date(),
              },
            );
          } catch (error) {
            this.logger.error(
              { userId, phoneNumber, error },
              "WebSocket recovery failed",
            );
          }
        }
      },
    );

    // Handle connection restart requests
    this.errorHandler.on(
      "connection-restart-needed",
      async ({ connectionId, userId, phoneNumber }) => {
        this.logger.info(
          { connectionId, userId, phoneNumber },
          "Connection restart requested",
        );

        if (userId && phoneNumber) {
          try {
            // Remove current connection and reconnect
            await this.removeConnection(userId, phoneNumber);
            await this.sleep(5000); // Wait before reconnecting

            // Get stored country from database
            const storedCountry = await this.getStoredCountry(
              userId,
              phoneNumber,
            );

            await this.errorHandler.executeWithRetry(
              () =>
                this.addConnection(
                  userId,
                  phoneNumber,
                  storedCountry, // Use stored country from DB
                ),
              {
                userId,
                phoneNumber,
                connectionId,
                operation: "connection-restart",
                timestamp: new Date(),
              },
            );
          } catch (error) {
            this.logger.error(
              { userId, phoneNumber, error },
              "Connection restart failed",
            );
          }
        }
      },
    );

    // Handle connection refresh requests
    this.errorHandler.on(
      "connection-refresh-needed",
      async ({ connectionId, userId, phoneNumber }) => {
        this.logger.info(
          { connectionId, userId, phoneNumber },
          "Connection refresh requested",
        );

        if (userId && phoneNumber) {
          const connection = this.connections.get(connectionId);
          if (connection && this.wsManager) {
            try {
              // Refresh WebSocket health
              await this.wsManager.refreshConnectionHealth(
                connectionId,
                connection.socket,
              );
            } catch (error) {
              this.logger.error(
                { userId, phoneNumber, error },
                "Connection refresh failed",
              );
            }
          }
        }
      },
    );

    // Handle reconnection requests
    this.errorHandler.on(
      "reconnection-needed",
      async ({ connectionId, userId, phoneNumber }) => {
        this.logger.info(
          { connectionId, userId, phoneNumber },
          "Reconnection requested",
        );

        if (userId && phoneNumber) {
          // Use existing reconnect logic with error handling
          try {
            await this.reconnect(userId, phoneNumber);
          } catch (error) {
            this.logger.error(
              { userId, phoneNumber, error },
              "Reconnection failed",
            );
          }
        }
      },
    );

    // Handle graceful shutdown
    this.errorHandler.on("graceful-shutdown", () => {
      this.logger.info("Graceful shutdown requested by error handler");
      this.shutdown().catch((error) => {
        this.logger.error({ error }, "Error during graceful shutdown");
      });
    });
  }

  /**
   * Setup instance coordinator event listeners
   */
  private setupInstanceCoordinatorListeners(): void {
    // Handle session transfer requests
    this.instanceCoordinator.on(
      "session-transfer-needed",
      async ({ sessionKey, targetInstanceId, reason }) => {
        this.logger.info(
          { sessionKey, targetInstanceId, reason },
          "Session transfer requested",
        );

        const [userId, phoneNumber] = sessionKey.split(":");
        if (userId && phoneNumber) {
          try {
            // Release current connection gracefully
            await this.removeConnection(userId, phoneNumber);
            this.logger.info(
              { sessionKey, targetInstanceId },
              "Session released for transfer",
            );
          } catch (error) {
            this.logger.error(
              { sessionKey, error },
              "Error during session transfer",
            );
          }
        }
      },
    );

    // Handle load balancing recommendations
    this.instanceCoordinator.on(
      "load-balance-recommendation",
      ({ action, details }) => {
        this.logger.info(
          { action, details },
          "Load balancing recommendation received",
        );

        if (action === "reject_new_connections") {
          this.logger.warn(
            "Instance coordinator recommends rejecting new connections due to high load",
          );
        } else if (action === "accept_more_connections") {
          this.logger.info(
            "Instance coordinator indicates capacity available for new connections",
          );
        }
      },
    );

    // Handle instance health status changes
    this.instanceCoordinator.on(
      "instance-health-changed",
      ({ instanceId, status, reason }) => {
        this.logger.info(
          { instanceId, status, reason },
          "Instance health status changed",
        );

        if (
          status === "failed" &&
          instanceId !== this.instanceCoordinator.getInstanceId()
        ) {
          this.logger.warn(
            { instanceId },
            "Another instance has failed - monitoring for session transfers",
          );
        }
      },
    );
  }

  /**
   * Initialize recovery of previous connections after server restart
   */
  async initializeRecovery(): Promise<void> {
    this.logger.info(
      "Starting automatic connection recovery after server restart",
    );

    try {
      // First, get all sessions from the filesystem (primary source)
      const filesystemSessions = await this.sessionManager.listAllSessions();

      this.logger.info(
        { count: filesystemSessions.length },
        "Found sessions in filesystem",
      );

      // Then get Firestore states if available (for metadata)
      let firestoreStates: Map<string, any> = new Map();
      if (this.connectionStateManager) {
        const states = await this.connectionStateManager.recoverConnections();
        states.forEach((state) => {
          const key = `${state.userId}:${state.phoneNumber}`;
          firestoreStates.set(key, state);
        });
        this.logger.info(
          { count: states.length },
          "Found connection states in Firestore",
        );
      }

      if (filesystemSessions.length === 0) {
        this.logger.info("No sessions to recover");
        return;
      }

      // Recover each session found in filesystem
      let recoveredCount = 0;
      let failedCount = 0;
      let skippedCount = 0;

      for (const session of filesystemSessions) {
        const { userId, phoneNumber } = session;
        const stateKey = `${userId}:${phoneNumber}`;
        const firestoreState = firestoreStates.get(stateKey);

        // Check if explicitly logged out in Firestore
        if (firestoreState && firestoreState.status === "logged_out") {
          this.logger.info(
            { userId, phoneNumber },
            "Skipping recovery - user logged out",
          );
          skippedCount++;
          continue;
        }

        this.logger.info(
          {
            userId,
            phoneNumber,
            hasFirestoreState: !!firestoreState,
            previousStatus: firestoreState?.status,
          },
          "Attempting to recover WhatsApp connection from session files",
        );

        try {
          // Use stored country from Firestore if available, otherwise undefined
          const storedCountry =
            firestoreState?.proxy_country || firestoreState?.country_code;

          // Attempt recovery using session files
          const success = await this.addConnection(
            userId,
            phoneNumber,
            storedCountry, // Use stored country from DB (e.g., "nl" for Dutch numbers)
            undefined, // No country code needed
            true, // Mark as recovery
          );

          if (success) {
            recoveredCount++;
            this.logger.info(
              { userId, phoneNumber },
              "Successfully recovered WhatsApp connection",
            );
          } else {
            failedCount++;
            this.logger.warn(
              { userId, phoneNumber },
              "Failed to recover WhatsApp connection",
            );
          }
        } catch (error) {
          failedCount++;
          this.logger.error(
            {
              userId,
              phoneNumber,
              error,
            },
            "Error recovering WhatsApp connection",
          );
        }
      }

      this.logger.info(
        {
          total: filesystemSessions.length,
          recovered: recoveredCount,
          failed: failedCount,
          skipped: skippedCount,
        },
        "Connection recovery complete",
      );

      // Emit recovery complete event
      this.emit("recovery-complete", {
        total: filesystemSessions.length,
        recovered: recoveredCount,
        failed: failedCount,
        skipped: skippedCount,
      });
    } catch (error) {
      this.logger.error({ error }, "Failed to initialize connection recovery");
      throw error;
    }
  }

  /**
   * Add a new WhatsApp connection to the pool
   */
  async addConnection(
    userId: string,
    phoneNumber: string,
    proxyCountry?: string,
    countryCode?: string,
    isRecovery: boolean = false,
    browserName?: string,
  ): Promise<boolean> {
    // 🟢 BUG #4 FIX: Check if pool is shutting down before adding connection
    if (this.isShuttingDown) {
      this.logger.warn(
        { userId, phoneNumber },
        "Cannot add connection: pool is shutting down",
      );
      return false;
    }

    // Format the phone number to ensure consistent E.164 format
    const formattedNumber = formatPhoneNumberSafe(
      phoneNumber,
      countryCode as any,
    );
    if (!formattedNumber) {
      this.logger.error(
        { userId, phoneNumber, countryCode },
        "Invalid phone number format",
      );
      throw new Error(`Invalid phone number format: ${phoneNumber}`);
    }

    // Use the formatted number for all operations
    phoneNumber = formattedNumber;
    this.logger.info(
      {
        userId,
        originalPhone: phoneNumber,
        formattedPhone: formattedNumber,
      },
      "Adding connection with formatted phone number",
    );
    const connectionKey = this.getConnectionKey(userId, phoneNumber);

    // Check instance coordination - request session ownership
    if (!isRecovery) {
      const shouldHandle = await this.instanceCoordinator.shouldHandleSession(
        userId,
        phoneNumber,
      );
      if (!shouldHandle) {
        // Try to request ownership
        const ownershipGranted =
          await this.instanceCoordinator.requestSessionOwnership(
            userId,
            phoneNumber,
          );
        if (!ownershipGranted) {
          this.logger.info(
            { userId, phoneNumber, connectionKey },
            "Session is owned by another instance, rejecting connection request",
          );
          return false;
        }
      }
    }

    // Check if connection already exists
    if (this.connections.has(connectionKey)) {
      const existing = this.connections.get(connectionKey)!;
      if (
        existing.state.connection === "open" ||
        existing.state.connection === "connecting"
      ) {
        this.logger.info(
          { userId, phoneNumber, state: existing.state.connection },
          "Connection already exists and is active, not creating duplicate",
        );
        return true;
      } else if (existing.state.connection === "close") {
        // Remove closed connection before creating new one
        this.logger.info(
          { userId, phoneNumber },
          "Removing closed connection before creating new one",
        );
        this.connections.delete(connectionKey);
      }
    }

    // Check capacity
    if (!this.hasCapacity()) {
      this.logger.warn(
        {
          currentConnections: this.connections.size,
          maxConnections: this.config.maxConnections,
        },
        "Connection pool at capacity",
      );
      this.emit("capacity-reached");
      return false;
    }

    try {
      // Initialize connection state if manager is available
      if (this.connectionStateManager) {
        if (isRecovery) {
          // Update existing state for recovery
          // Don't update status - let the connection lifecycle handle status naturally
          await this.connectionStateManager.updateState(userId, phoneNumber, {
            instanceUrl: this.config.instanceUrl,
          });
        } else {
          // Initialize new state
          await this.connectionStateManager.initializeState(
            userId,
            phoneNumber,
            this.config.instanceUrl,
          );
        }
      }

      // Phone number record should already be created by Cloud Function
      // before calling the WhatsApp Web Service

      // Create connection with proxy and custom browser name
      // Skip proxy creation during recovery since SessionRecoveryService already has one
      const socket = await this.sessionManager.createConnection(
        userId,
        phoneNumber,
        proxyCountry,
        browserName,
        isRecovery, // Skip proxy creation if this is a recovery
      );

      const connection: WhatsAppConnection = {
        userId,
        phoneNumber,
        socket,
        state: { connection: "connecting" } as ConnectionState,
        hasConnectedSuccessfully: false,
        proxyCountry: proxyCountry,
        createdAt: new Date(),
        lastActivity: new Date(),
        messageCount: 0,
        instanceUrl: this.config.instanceUrl,
        proxySessionId: proxyCountry,
        isRecovery: isRecovery, // Track if this is a recovery connection
        syncCompleted: isRecovery, // Recovery connections are already synced, first-time are not
        handshakeCompleted: isRecovery, // Recovery connections skip handshake, first-time connections need handshake
      };

      // Set up event handlers
      this.setupConnectionHandlers(connection);

      // Add to pool
      this.connections.set(connectionKey, connection);

      // Update session activity in instance coordinator
      if (!isRecovery) {
        await this.instanceCoordinator.updateSessionActivity(
          userId,
          phoneNumber,
        );
      }

      // Update Firestore
      await this.updateConnectionStatus(userId, phoneNumber, "initializing");

      this.logger.info(
        { userId, phoneNumber, totalConnections: this.connections.size },
        "Added new connection to pool",
      );

      return true;
    } catch (error) {
      this.logger.error(
        { userId, phoneNumber, error },
        "Failed to add connection",
      );
      return false;
    }
  }

  /**
   * Remove a connection from the pool
   * @param userId - The user ID
   * @param phoneNumber - The phone number to disconnect
   * @param skipLogout - If true, preserve session for reconnection; if false, perform full logout
   * @param reason - The reason for disconnection (e.g., "deleted", "manual", "disabled")
   */
  async removeConnection(
    userId: string,
    phoneNumber: string,
    skipLogout = false,
    reason?: string,
  ): Promise<void> {
    // Format phone number for consistency
    const formattedPhone = formatPhoneNumberSafe(phoneNumber);
    if (formattedPhone) {
      phoneNumber = formattedPhone;
    }

    const connectionKey = this.getConnectionKey(userId, phoneNumber);
    const connection = this.connections.get(connectionKey);

    if (!connection) {
      this.logger.debug(
        { userId, phoneNumber, connectionKey },
        "Connection not found for removal (might already be removed)",
      );
      return;
    }

    // 🟢 Delete from map FIRST to prevent concurrent access during cleanup
    this.connections.delete(connectionKey);

    try {
      // Clear QR timeout if exists
      if (connection.qrTimeout) {
        clearTimeout(connection.qrTimeout);
        connection.qrTimeout = undefined;
      }

      // Logout from WhatsApp (unless we want to preserve session)
      if (!skipLogout) {
        try {
          await connection.socket.logout();
          this.logger.info(
            { userId, phoneNumber },
            "WhatsApp session logged out successfully",
          );
        } catch (logoutError) {
          this.logger.warn(
            { userId, phoneNumber, logoutError },
            "Failed to logout cleanly, proceeding with connection end",
          );
        }
      } else {
        this.logger.info(
          { userId, phoneNumber },
          "Gracefully closing connection without logout to preserve session",
        );
      }

      // Close the socket
      connection.socket.end(undefined);

      // 🟢 CRITICAL FIX: Clean up all event listeners to prevent memory leak
      // TypeScript types require an event parameter, but EventEmitter allows calling without args
      // to remove ALL listeners across ALL events - this is what we want for cleanup
      (connection.socket.ev.removeAllListeners as any)();

      // Unregister from WebSocket manager
      this.wsManager.unregisterConnection(connectionKey);

      // Clean up associated caches
      const sessionKey = `${userId}-${phoneNumber}`;
      if (this.processedContactsCache.has(sessionKey)) {
        const cacheSize =
          this.processedContactsCache.get(sessionKey)?.size || 0;
        this.processedContactsCache.delete(sessionKey);
        this.logger.debug(
          { userId, phoneNumber, cacheSize },
          "Cleared deduplication cache for disconnected session",
        );
      }
      this.importListRefs.delete(sessionKey);
      this.syncedContactInfo.clear(); // Clear synced contact info as it's session-specific

      // Release the proxy immediately
      await this.proxyManager.releaseProxy(userId, phoneNumber);

      // Update Firestore - preserve status for recovery when preserving session
      if (!skipLogout) {
        // Don't update Firestore status for permanent deletions
        // The document is being deleted, so writing "disconnected" status would recreate it
        if (reason !== "deleted") {
          await this.updateConnectionStatus(userId, phoneNumber, "disconnected");
          // Remove from recovery tracking since it's a normal disconnect
          await this.removeSessionFromRecovery(userId, phoneNumber);
          this.logger.info(
            { userId, phoneNumber, reason },
            "Updated connection status to disconnected",
          );
        } else {
          this.logger.info(
            { userId, phoneNumber },
            "Skipping status update for permanent deletion - document is being removed",
          );
        }
      } else {
        // Mark session as pending recovery for graceful shutdown
        await this.updateSessionForRecovery(
          userId,
          phoneNumber,
          "pending_recovery",
          connection.proxyCountry,
        );
        this.logger.info(
          { userId, phoneNumber },
          "Session preserved for recovery in users subcollection",
        );
      }

      // Release session ownership in instance coordinator
      await this.instanceCoordinator.releaseSessionOwnership(
        userId,
        phoneNumber,
      );

      this.logger.info(
        { userId, phoneNumber, totalConnections: this.connections.size },
        "Removed connection from pool and released proxy",
      );
    } catch (error) {
      this.logger.error(
        { userId, phoneNumber, error },
        "Error removing connection",
      );
    }
  }

  /**
   * Get a connection from the pool
   */
  getConnection(
    userId: string,
    phoneNumber: string,
  ): WhatsAppConnection | null {
    const connectionKey = this.getConnectionKey(userId, phoneNumber);
    return this.connections.get(connectionKey) || null;
  }

  /**
   * Get the media service instance
   */
  getMediaService(): MediaService {
    return this.mediaService;
  }

  /**
   * Send a message using a connection from the pool
   */
  async sendMessage(
    userId: string,
    phoneNumber: string,
    toNumber: string,
    content: WAMessageContent,
  ): Promise<WAMessageKey | null> {
    const sendStartTime = Date.now();
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Log send attempt with details
    this.logger.debug(
      {
        messageId,
        userId,
        phoneNumber: phoneNumber,
        toNumber: toNumber,
        body:
          (content as any).text ||
          (content as any).caption ||
          "[Media Message]",
        contentType: (content as any).text ? "text" : Object.keys(content)[0],
        hasCaption: !!(content as any).caption,
        operation: "send_message_attempt",
      },
      "Attempting to send WhatsApp message",
    );

    const connection = this.getConnection(userId, phoneNumber);

    if (!connection || connection.state.connection !== "open") {
      this.logger.error(
        {
          messageId,
          userId,
          phoneNumber: phoneNumber,
          toNumber: toNumber,
          body:
            (content as any).text ||
            (content as any).caption ||
            "[Media Message]",
          connectionExists: !!connection,
          connectionState: connection?.state?.connection,
          error: "no_active_connection",
        },
        "No active connection for sending message",
      );
      return null;
    }

    try {
      const jid = this.formatJid(toNumber);

      // Log pre-send details
      this.logger.debug(
        {
          messageId,
          userId,
          jid,
          socketState: connection.state.connection,
          messageCount: connection.messageCount,
          lastActivity: connection.lastActivity,
        },
        "Sending message via WhatsApp socket",
      );

      const socketSendStart = Date.now();
      const result = await connection.socket.sendMessage(jid, content as any);
      const socketSendDuration = Date.now() - socketSendStart;

      // Log detailed WhatsApp response
      this.logger.info(
        {
          messageId,
          userId,
          phoneNumber: phoneNumber,
          toNumber: toNumber,
          body:
            (content as any).text ||
            (content as any).caption ||
            "[Media Message]",
          whatsappMessageId: result?.key?.id,
          whatsappStatus: result?.status,
          serverMessageId: result?.key?.id,
          remoteJid: result?.key?.remoteJid,
          fromMe: result?.key?.fromMe,
          participant: result?.key?.participant,
          socketSendDuration,
          totalDuration: Date.now() - sendStartTime,
          timestamp: new Date().toISOString(),
        },
        "WhatsApp message response received",
      );

      connection.lastActivity = new Date();
      connection.messageCount++;

      // Publish message sent event
      if (result && result.key && result.key.id) {
        // Track this message as sent via API
        this.sentMessageIds.set(result.key.id, new Date());

        // Auto-cleanup after 5 minutes
        const messageId = result.key.id; // Capture for closure
        setTimeout(
          () => {
            this.sentMessageIds.delete(messageId);
          },
          5 * 60 * 1000,
        );

        const publishStart = Date.now();
        await this.publishEvent("message-sent", {
          userId,
          phoneNumber,
          toNumber,
          messageId: result.key.id,
          timestamp: new Date().toISOString(),
        });

        this.logger.debug(
          {
            messageId,
            whatsappMessageId: result.key.id,
            publishDuration: Date.now() - publishStart,
            totalMessageCount: connection.messageCount,
          },
          "Message sent event published",
        );

        // Update contact with outgoing message timestamp
        try {
          const contactsQuery = await admin
            .firestore()
            .collection("users")
            .doc(userId)
            .collection("contacts")
            .where("phone_number", "==", toNumber)
            .limit(1)
            .get();

          if (!contactsQuery.empty) {
            await contactsQuery.docs[0].ref.update({
              last_outgoing_message_at: admin.firestore.Timestamp.now(),
              last_activity_at: admin.firestore.Timestamp.now(),
              channel: "whatsapp_web",
            });

            this.logger.debug(
              { userId, toNumber, messageId },
              "Updated contact with outgoing message timestamp",
            );
          } else {
            this.logger.warn(
              { userId, toNumber, messageId },
              "Contact not found for outgoing message timestamp update",
            );
          }
        } catch (error) {
          // Log but don't fail the send operation
          this.logger.warn(
            {
              userId,
              toNumber: toNumber?.substring(0, 6) + "***",
              error,
              messageId,
            },
            "Failed to update contact with outgoing timestamp",
          );
        }

        // Log successful completion with all metrics
        this.logger.info(
          {
            messageId,
            userId,
            whatsappMessageId: result.key.id,
            totalDuration: Date.now() - sendStartTime,
            success: true,
          },
          "Message send completed successfully",
        );

        return result.key;
      }

      // Log case where no key was returned
      this.logger.warn(
        {
          messageId,
          userId,
          result: result ? "result_exists_but_no_key" : "no_result",
          duration: Date.now() - sendStartTime,
        },
        "Message sent but no key returned",
      );

      return null;
    } catch (error: any) {
      const errorDuration = Date.now() - sendStartTime;

      // Detailed error logging
      this.logger.error(
        {
          messageId,
          userId,
          phoneNumber: phoneNumber?.substring(0, 6) + "***",
          toNumber: toNumber?.substring(0, 6) + "***",
          error: error.message,
          errorCode: error.code,
          errorType: error.name,
          errorStack: error.stack,
          duration: errorDuration,
          connectionState: connection.state.connection,
          isProxyError: this.isProxyError(error),
        },
        "Failed to send message via WhatsApp",
      );

      // Check if we need to rotate proxy
      if (this.isProxyError(error)) {
        this.logger.warn(
          {
            messageId,
            userId,
            phoneNumber: phoneNumber?.substring(0, 6) + "***",
            error: "proxy_error_detected",
          },
          "Proxy error detected, initiating rotation",
        );

        await this.handleProxyError(userId, phoneNumber);
      }

      return null;
    }
  }

  /**
   * Setup event handlers for a connection
   */
  private setupConnectionHandlers(connection: WhatsAppConnection) {
    const { socket, userId, phoneNumber } = connection;

    // Register with WebSocket manager for enhanced monitoring
    const connectionId = this.getConnectionKey(userId, phoneNumber);
    this.wsManager.registerConnection(connectionId, socket);

    this.logger.debug(
      { userId, phoneNumber },
      "Connection registered with WebSocket manager and memory leak prevention",
    );

    // Track if sync has been completed to avoid duplicate events
    let syncCompleted = false;

    // Track cumulative sync counts for this connection
    let totalContactsSynced = 0;
    let totalMessagesSynced = 0;

    socket.ev.on("connection.update", async (update) => {
      connection.state = update as ConnectionState;

      const { connection: state, lastDisconnect, qr } = update;

      this.logger.info(
        {
          userId,
          phoneNumber,
          state,
          hasQR: !!qr,
          updateKeys: Object.keys(update),
        },
        "Connection update received",
      );

      // Emit connecting state if applicable
      // Don't regress status if we're already past the connecting phase
      // CRITICAL: Check Firestore status first to prevent overwriting import states
      if (state === "connecting" && !connection.syncCompleted) {
        // Check current Firestore status to avoid regression
        const phoneDoc = await this.firestore
          .collection("users")
          .doc(userId)
          .collection("phone_numbers")
          .doc(phoneNumber)
          .get();

        const currentStatus = phoneDoc.data()?.whatsapp_web?.status;
        const isImporting =
          currentStatus &&
          (currentStatus.includes("importing") ||
            currentStatus === "importing_contacts" ||
            currentStatus === "importing_messages");

        if (!isImporting) {
          // Only update to "connecting" if we're not already importing
          await this.updatePhoneNumberStatus(
            userId,
            phoneNumber,
            "connecting",
          );

          this.emit("connection-update", {
            userId,
            phoneNumber,
            status: "connecting",
          });
        } else {
          this.logger.debug(
            { userId, phoneNumber, currentStatus, baileysState: state },
            "Skipping 'connecting' status update - already in import phase (preventing regression)",
          );
        }
      }

      if (qr) {
        this.logger.info(
          { userId, phoneNumber, qrLength: qr.length },
          "QR code received from Baileys",
        );
        connection.qrCode = qr;
        await this.handleQRCode(userId, phoneNumber, qr);

        // Clear any existing QR timeout before setting a new one to prevent race condition
        if (connection.qrTimeout) {
          clearTimeout(connection.qrTimeout);
          connection.qrTimeout = undefined;
        }

        // Set QR expiration timeout to prevent orphaned proxies
        connection.qrTimeout = setTimeout(async () => {
          if (!connection.hasConnectedSuccessfully) {
            this.logger.warn(
              { userId, phoneNumber },
              "QR code expired without connection - removing connection to prevent proxy leak",
            );
            await this.removeConnection(userId, phoneNumber);
          }
        }, 90000); // 90 seconds timeout
      }

      if (state === "open") {
        connection.qrCode = undefined;
        connection.hasConnectedSuccessfully = true;

        // Clear QR timeout since connection is now established
        if (connection.qrTimeout) {
          clearTimeout(connection.qrTimeout);
          connection.qrTimeout = undefined;
        }

        // Update connection state manager if available
        // For recovery connections, mark as connected immediately
        // For first-time connections, defer until sync completes
        if (this.connectionStateManager && connection.isRecovery) {
          await this.connectionStateManager.markConnected(userId, phoneNumber);
          this.logger.info(
            { userId, phoneNumber },
            "Marked connection as connected in state manager (recovery)",
          );
        }

        // Release proxy after successful connection - TCP tunnel persists
        // 30 second delay to ensure connection is truly stable (past any pairing restarts)
        setTimeout(async () => {
          try {
            // Verify connection is still active and stable before releasing proxy
            const connectionKey = `${userId}:${phoneNumber}`;
            const currentConnection = this.connections.get(connectionKey);

            if (
              currentConnection &&
              currentConnection.state?.connection === "open" &&
              !currentConnection.proxyReleased &&
              currentConnection.hasConnectedSuccessfully
            ) {
              await this.proxyManager.releaseProxy(userId, phoneNumber);
              currentConnection.proxyReleased = true;

              this.logger.info(
                {
                  userId,
                  phoneNumber,
                  proxySessionId: currentConnection.proxySessionId,
                  delaySeconds: 30,
                },
                "Proxy released after stable connection - tunnel persists for cost optimization",
              );
            } else {
              this.logger.debug(
                {
                  userId,
                  phoneNumber,
                  connectionExists: !!currentConnection,
                  connectionState: currentConnection?.state?.connection,
                  alreadyReleased: currentConnection?.proxyReleased,
                  hasConnected: currentConnection?.hasConnectedSuccessfully,
                },
                "Skipping proxy release - connection not stable or already released",
              );
            }
          } catch (error) {
            this.logger.warn(
              { userId, phoneNumber, error: (error as any).message },
              "Failed to release proxy after stable connection, but connection continues",
            );
          }
        }, 30000); // 30 seconds to avoid pairing restart issues

        // Determine initial status based on connection type
        // First-time connections: Show "importing_messages" so users see the import
        // Reconnections/Recovery: Show "connected" immediately for instant messaging
        const initialStatus = connection.isRecovery
          ? "connected"
          : "importing_messages";

        // Update phone number status for UI
        await this.updatePhoneNumberStatus(userId, phoneNumber, initialStatus);

        // Track session for recovery (always use "connected" since the connection is open)
        // Note: Recovery tracking is separate from UI status - it tracks if session can be recovered
        await this.updateSessionForRecovery(
          userId,
          phoneNumber,
          "connected", // Always "connected" for recovery tracking, regardless of UI status
          connection.proxyCountry,
        );

        // Emit connection established event
        this.emit("connection-update", {
          userId,
          phoneNumber,
          status: initialStatus,
        });

        this.logger.info(
          {
            userId,
            phoneNumber,
            isRecovery: connection.isRecovery,
            initialStatus,
          },
          "WhatsApp connection established",
        );

        // Emit sync started event with small delay to ensure WebSocket clients are ready
        setTimeout(async () => {
          if (connection.isRecovery) {
            this.logger.info(
              { userId, phoneNumber, isRecovery: true },
              "Reconnection: Starting background sync - keeping status as 'connected' to allow messaging",
            );
          } else {
            this.logger.info(
              { userId, phoneNumber, isRecovery: false },
              "First-time connection: Starting import - status will show 'importing_messages'",
            );
          }

          // Initialize sync progress in database
          if (this.connectionStateManager) {
            await this.connectionStateManager.updateSyncProgress(
              userId,
              phoneNumber,
              0, // contacts count (starting)
              0, // messages count (starting)
              false, // not completed yet
            );
          }

          this.emit("sync:started", {
            userId,
            phoneNumber,
            timestamp: new Date().toISOString(),
          });
        }, 100);

        // Set a longer timeout for sync completion
        // Give more time for messages to sync in background
        setTimeout(async () => {
          // Only emit if sync hasn't completed yet
          if (!syncCompleted) {
            syncCompleted = true;
            this.logger.info(
              { userId, phoneNumber, isRecovery: connection.isRecovery },
              "Sync timeout reached, completing sync",
            );

            // Mark sync as completed in database
            if (this.connectionStateManager) {
              await this.connectionStateManager.updateSyncProgress(
                userId,
                phoneNumber,
                totalContactsSynced,
                totalMessagesSynced,
                true, // sync completed
              );
            }

            // Update phone number status for UI - sync completed
            // Only transition to "connected" if we have actual data OR it's a recovery
            // This prevents premature "connected" status when no messages were synced
            if (
              connection.isRecovery ||
              totalContactsSynced > 0 ||
              totalMessagesSynced > 0
            ) {
              // For recovery, this is a no-op (status already "connected")
              // For new connections with data, transition from "importing" to "connected"
              await this.updatePhoneNumberStatus(
                userId,
                phoneNumber,
                "connected",
              );
            } else {
              // No data synced - keep as importing_messages to indicate still waiting
              this.logger.warn(
                { userId, phoneNumber },
                "Sync timeout with no data - keeping import status instead of connected",
              );
              // Don't change status - let it remain as "importing_messages"
              // The connectionStateManager.updateSyncProgress above will handle the status
            }

            // Emit sync completion event with cumulative totals
            this.emit("history-synced", {
              userId,
              phoneNumber,
              contacts: totalContactsSynced,
              messages: totalMessagesSynced,
              timedOut: true,
            });
          }
        }, 90000); // 90 seconds timeout for accounts with more data
      }

      if (state === "close") {
        const disconnectReason = (lastDisconnect?.error as any)?.output
          ?.statusCode;

        // Handle expected restart after QR pairing (error code 515)
        if (disconnectReason === DisconnectReason.restartRequired) {
          this.logger.info(
            { userId, phoneNumber },
            "Connection restart required after pairing - this is expected",
          );
          connection.qrCode = undefined; // Clear QR as we're now paired
          connection.hasConnectedSuccessfully = true; // Mark as successfully connected
          connection.handshakeCompleted = true; // Handshake phase is now complete, subsequent status updates should be saved

          // Clear QR timeout to prevent it from firing during restart
          if (connection.qrTimeout) {
            clearTimeout(connection.qrTimeout);
            connection.qrTimeout = undefined;
            this.logger.debug(
              { userId, phoneNumber },
              "Cleared QR timeout before restart to prevent race condition",
            );
          }

          // Emit status update
          this.emit("connection-update", {
            userId,
            phoneNumber,
            status: "restarting",
          });

          // Immediate reconnect with no delay for pairing restart
          await this.reconnect(userId, phoneNumber, 0);
          return;
        }

        // Handle connection replaced error (440) - session active elsewhere
        if (disconnectReason === DisconnectReason.connectionReplaced) {
          this.logger.warn(
            {
              userId,
              phoneNumber,
              disconnectReason,
              hasConnectedSuccessfully: connection.hasConnectedSuccessfully,
            },
            "Connection replaced - checking if this is during initial connection or session takeover",
          );

          // If connection never succeeded, this might be a conflict during reconnection
          // where the same session is trying to connect twice. The connection may recover,
          // so we should NOT immediately delete it. Wait to see if it reconnects.
          if (!connection.hasConnectedSuccessfully) {
            this.logger.info(
              { userId, phoneNumber },
              "Connection replaced during initial connection - may be reconnection conflict, keeping in pool to allow recovery",
            );

            // Set a timeout to clean up if connection doesn't recover
            setTimeout(async () => {
              const key = this.getConnectionKey(userId, phoneNumber);
              const currentConnection = this.connections.get(key);

              // Only delete if still not connected after 10 seconds
              if (
                currentConnection &&
                currentConnection.state.connection !== "open"
              ) {
                this.logger.warn(
                  { userId, phoneNumber },
                  "Connection did not recover after replacement, removing from pool",
                );

                // Update state manager
                if (this.connectionStateManager) {
                  await this.connectionStateManager.updateState(
                    userId,
                    phoneNumber,
                    {
                      status: "disconnected",
                      lastError: "Connection replaced and did not recover",
                    },
                  );
                }

                this.connections.delete(key);

                // Emit disconnection event
                this.emit("connection-update", {
                  userId,
                  phoneNumber,
                  status: "disconnected",
                });
              } else if (
                currentConnection &&
                currentConnection.state.connection === "open"
              ) {
                this.logger.info(
                  { userId, phoneNumber },
                  "Connection recovered successfully after replacement",
                );
              }
            }, 10000); // 10 second timeout

            return; // Don't immediately delete or reconnect
          }

          // If connection was previously successful, this is a real takeover - remove it
          this.logger.warn(
            { userId, phoneNumber },
            "Previously connected session replaced by another instance, removing",
          );

          // Update state manager if available
          if (this.connectionStateManager) {
            await this.connectionStateManager.updateState(userId, phoneNumber, {
              status: "disconnected",
              lastError: "Connection replaced by another instance",
            });
          }

          // Remove from pool but don't try to reconnect
          const key = this.getConnectionKey(userId, phoneNumber);
          this.connections.delete(key);

          // Emit disconnection event
          this.emit("connection-update", {
            userId,
            phoneNumber,
            status: "disconnected",
          });

          return; // Don't reconnect
        }

        const shouldReconnect = disconnectReason !== DisconnectReason.loggedOut;

        // Update connection state manager if available
        if (this.connectionStateManager) {
          if (shouldReconnect) {
            await this.connectionStateManager.updateState(userId, phoneNumber, {
              status: "disconnected",
              lastError: `Disconnect reason: ${disconnectReason}`,
            });
          } else {
            await this.connectionStateManager.markDisconnected(
              userId,
              phoneNumber,
              "Logged out",
            );
          }
        }

        // Emit connection closed event
        this.emit("connection-update", {
          userId,
          phoneNumber,
          status: "disconnected",
        });

        if (shouldReconnect && !this.isShuttingDown) {
          this.logger.info(
            { userId, phoneNumber, disconnectReason },
            "Connection closed, attempting reconnect with error handling",
          );

          // Use error handler for graceful reconnection
          try {
            const lastError = lastDisconnect?.error as Error;
            const errorHandled = await this.errorHandler.handleError(
              lastError ||
                new Error(`Connection closed with reason: ${disconnectReason}`),
              {
                userId,
                phoneNumber,
                connectionId,
                operation: "connection_update_reconnect",
                errorCode: String(disconnectReason),
                timestamp: new Date(),
              },
            );

            if (!errorHandled) {
              // Fallback to direct reconnection if error handler can't handle it
              await this.reconnect(userId, phoneNumber);
            }
          } catch (error) {
            this.logger.error(
              { userId, phoneNumber, error },
              "Error handling failed, attempting direct reconnection",
            );
            await this.reconnect(userId, phoneNumber);
          }
        } else if (shouldReconnect && this.isShuttingDown) {
          this.logger.info(
            { userId, phoneNumber, disconnectReason },
            "Skipping reconnection during graceful shutdown",
          );
        } else {
          await this.removeConnection(userId, phoneNumber);
        }
      }
    });

    // Unified message handling - processes both real-time and history messages
    socket.ev.on("messages.upsert", async (upsert) => {
      try {
        // Update session activity for any message activity
        await this.instanceCoordinator.updateSessionActivity(
          userId,
          phoneNumber,
        );

        // Determine if these are history messages or real-time messages
        // Only "append" type is for history sync, "notify" is for real-time incoming messages
        const isHistorySync = upsert.type === "append";
        const hourAgo = Date.now() - 60 * 60 * 1000;

        // Separate messages into history and real-time
        const historyMessages: any[] = [];
        const realtimeMessages: any[] = [];

        for (const msg of upsert.messages) {
          if (!msg.message) continue; // Skip empty messages

          const msgTime = Number(msg.messageTimestamp || 0) * 1000;
          const isOldMessage = msgTime < hourAgo;

          if (isHistorySync || isOldMessage) {
            // This is a history message from sync
            historyMessages.push(msg);
          } else {
            // This is a real-time message
            realtimeMessages.push(msg);
          }
        }

        // Process history messages if any
        if (historyMessages.length > 0) {
          this.logger.info(
            {
              userId,
              phoneNumber,
              type: upsert.type,
              count: historyMessages.length,
              requestId: upsert.requestId,
              firstMessage: historyMessages[0]
                ? {
                    id: historyMessages[0].key?.id,
                    remoteJid: historyMessages[0].key?.remoteJid,
                    timestamp: historyMessages[0].messageTimestamp,
                  }
                : null,
            },
            "Processing history messages from upsert",
          );

          const count = await this.processSyncedMessages(
            userId,
            phoneNumber,
            historyMessages,
          );
          totalMessagesSynced += count;

          // Update sync progress in database
          if (this.connectionStateManager) {
            await this.connectionStateManager.updateSyncProgress(
              userId,
              phoneNumber,
              totalContactsSynced,
              totalMessagesSynced,
              false,
            );
          }

          // Emit progress event
          this.emit("sync:progress", {
            userId,
            phoneNumber,
            type: "messages_from_upsert",
            count: historyMessages.length,
            timestamp: new Date().toISOString(),
          });
        }

        // Process real-time messages if any
        if (realtimeMessages.length > 0) {
          for (const msg of realtimeMessages) {
            try {
              if (!msg.key.fromMe) {
                // Incoming message from contact
                await this.handleIncomingMessage(userId, phoneNumber, msg);
              } else {
                // Outgoing message - could be manual or API-sent
                await this.handleOutgoingMessage(userId, phoneNumber, msg);
              }
            } catch (messageError) {
              // Handle individual message processing errors gracefully
              await this.errorHandler.handleError(messageError as Error, {
                userId,
                phoneNumber,
                connectionId,
                operation: "message_processing",
                timestamp: new Date(),
              });
            }
          }
        }

        connection.lastActivity = new Date();
      } catch (error) {
        // Handle overall message upsert errors
        await this.errorHandler.handleError(error as Error, {
          userId,
          phoneNumber,
          connectionId,
          operation: "messages_upsert",
          timestamp: new Date(),
        });
      }
    });

    // Message status updates
    socket.ev.on("messages.update", async (updates) => {
      try {
        for (const update of updates) {
          try {
            await this.handleMessageUpdate(userId, phoneNumber, update);
          } catch (updateError) {
            await this.errorHandler.handleError(updateError as Error, {
              userId,
              phoneNumber,
              connectionId,
              operation: "message_update_processing",
              timestamp: new Date(),
            });
          }
        }
      } catch (error) {
        await this.errorHandler.handleError(error as Error, {
          userId,
          phoneNumber,
          connectionId,
          operation: "messages_update",
          timestamp: new Date(),
        });
      }
    });

    // Presence updates
    socket.ev.on("presence.update", async (presenceUpdate) => {
      await this.handlePresenceUpdate(userId, phoneNumber, presenceUpdate);
    });

    // Chat updates (typing indicators)
    socket.ev.on("chats.update", async (chats) => {
      for (const chat of chats) {
        if ((chat as any).typing) {
          await this.handleTypingIndicator(userId, phoneNumber, chat.id!, true);
        }
      }
    });

    // History sync handler - process contacts and messages
    socket.ev.on("messaging-history.set", async (history) => {
      // Enhanced logging to debug message sync
      this.logger.info(
        {
          userId,
          phoneNumber,
          chats: history.chats?.length || 0,
          contacts: history.contacts?.length || 0,
          messages: history.messages?.length || 0,
          syncType: history.syncType,
          syncTypeString: history.syncType
            ? proto.HistorySync.HistorySyncType[history.syncType]
            : "unknown",
          isLatest: history.isLatest,
          progress: history.progress,
          hasMessages: !!history.messages && history.messages.length > 0,
          messagesSample: history.messages?.slice(0, 2).map((m: any) => ({
            id: m.key?.id,
            remoteJid: m.key?.remoteJid,
            fromMe: m.key?.fromMe,
            timestamp: m.messageTimestamp,
          })),
        },
        "Processing history sync data",
      );

      try {
        // Create import list if not already created for this sync session
        const sessionKey = `${userId}-${phoneNumber}`;
        if (!this.importListRefs.has(sessionKey)) {
          const listRef = await this.createImportList(userId, phoneNumber);
          if (listRef) {
            this.importListRefs.set(sessionKey, listRef);
          }
        }

        // SKIP processing all contacts - only process those with chat history
        // This prevents importing hundreds of contacts that never had conversations
        if (history.contacts && history.contacts.length > 0) {
          this.logger.info(
            {
              userId,
              phoneNumber,
              contactsCount: history.contacts.length,
            },
            "Skipping bulk contact import - will only import contacts with chat history",
          );

          // Update sync progress in database
          if (this.connectionStateManager) {
            await this.connectionStateManager.updateSyncProgress(
              userId,
              phoneNumber,
              0, // contacts count (skipped)
              totalMessagesSynced,
              false,
            );
          }

          // Still emit event but with 0 count to indicate we're not importing all contacts
          this.emit("contacts-synced", {
            userId,
            phoneNumber,
            count: 0,
            skipped: history.contacts.length,
            reason: "Only importing contacts with chat history",
          });
        }

        // Process chats (conversations) - pass socket for message history fetching
        // This will only create contacts that have actual chat history
        if (history.chats && history.chats.length > 0) {
          await this.processSyncedChats(
            userId,
            phoneNumber,
            history.chats,
            socket,
          );
        }

        // Process messages
        if (history.messages && history.messages.length > 0) {
          const count = await this.processSyncedMessages(
            userId,
            phoneNumber,
            history.messages,
          );
          totalMessagesSynced += count;

          // Update sync progress in database
          if (this.connectionStateManager) {
            await this.connectionStateManager.updateSyncProgress(
              userId,
              phoneNumber,
              totalContactsSynced,
              totalMessagesSynced,
              false,
            );
          }

          // Check if this is a recovery connection
          const connectionKey = this.getConnectionKey(userId, phoneNumber);
          const currentConnection = this.connections.get(connectionKey);
          const isRecoveryConnection = currentConnection?.isRecovery || false;

          // Update phone number status for UI - only for first-time connections
          // Recovery/reconnection keeps status as "connected" for background sync
          if (!isRecoveryConnection) {
            await this.updatePhoneNumberStatus(
              userId,
              phoneNumber,
              "importing_messages",
            );
          }

          // Emit message sync progress for UI updates
          this.emit("messages-synced", {
            userId,
            phoneNumber,
            count: count,
          });

          // Also emit generic progress event
          this.emit("sync:progress", {
            userId,
            phoneNumber,
            type: "messages_processed",
            count: history.messages.length,
            timestamp: new Date().toISOString(),
          });
        }

        // Only emit sync completion once, when we receive the latest batch
        // Complete sync when isLatest is true, regardless of message count in this batch
        if (!syncCompleted && history.isLatest) {
          syncCompleted = true;

          // Check if this is a recovery connection
          const connectionKey = this.getConnectionKey(userId, phoneNumber);
          const currentConnection = this.connections.get(connectionKey);
          const isRecoveryConnection = currentConnection?.isRecovery || false;

          this.logger.info(
            {
              userId,
              phoneNumber,
              totalContacts: totalContactsSynced,
              totalMessages: totalMessagesSynced,
              isRecovery: isRecoveryConnection,
            },
            "Latest history batch received, completing sync",
          );

          // Mark sync as completed in database
          if (this.connectionStateManager) {
            await this.connectionStateManager.updateSyncProgress(
              userId,
              phoneNumber,
              totalContactsSynced,
              totalMessagesSynced,
              true, // sync completed
            );
          }

          // Different behavior for first-time vs recovery connections
          if (isRecoveryConnection) {
            // Recovery/Reconnection: No status change, emit completion immediately
            this.logger.info(
              {
                userId,
                phoneNumber,
                totalContacts: totalContactsSynced,
                totalMessages: totalMessagesSynced,
              },
              "Recovery connection: Sync completed in background, status remains 'connected'",
            );

            // Mark sync as completed for this connection
            if (currentConnection) {
              currentConnection.syncCompleted = true;
            }

            // Emit sync completion event immediately
            this.emit("history-synced", {
              userId,
              phoneNumber,
              contacts: totalContactsSynced,
              messages: totalMessagesSynced,
            });
          } else {
            // First-time connection: Show importing status with grace period
            // Ensure status is set to importing_messages before the grace period
            await this.updatePhoneNumberStatus(
              userId,
              phoneNumber,
              "importing_messages",
            );

            // Add a grace period before marking as connected
            // This ensures the UI shows "importing" status for a reasonable duration
            // and allows any pending async operations to complete
            const SYNC_COMPLETION_DELAY = 3000; // 3 seconds

            this.logger.info(
              {
                userId,
                phoneNumber,
                delayMs: SYNC_COMPLETION_DELAY,
              },
              "First-time connection: Waiting for grace period before marking as fully synced",
            );

            setTimeout(async () => {
              try {
                this.logger.info(
                  {
                    userId,
                    phoneNumber,
                    totalContacts: totalContactsSynced,
                    totalMessages: totalMessagesSynced,
                  },
                  "Grace period completed, marking connection as synced",
                );

                // Mark sync as completed for this connection BEFORE updating status
                // This allows the defensive check in updatePhoneNumberStatus to pass
                const connKey = this.getConnectionKey(userId, phoneNumber);
                const conn = this.connections.get(connKey);
                if (conn) {
                  conn.syncCompleted = true;
                  this.logger.info(
                    { userId, phoneNumber },
                    "Marked connection as syncCompleted=true",
                  );
                }

                // Update phone number status for UI - sync completed
                // Now the defensive check will allow "connected" status
                await this.updatePhoneNumberStatus(
                  userId,
                  phoneNumber,
                  "connected",
                );

                // Mark as connected in ConnectionStateManager now that sync is complete
                if (this.connectionStateManager) {
                  await this.connectionStateManager.markConnected(
                    userId,
                    phoneNumber,
                  );
                  this.logger.info(
                    { userId, phoneNumber },
                    "Marked connection as connected in state manager (first-time, after sync)",
                  );
                }

                // Emit sync completion event with cumulative totals
                this.emit("history-synced", {
                  userId,
                  phoneNumber,
                  contacts: totalContactsSynced,
                  messages: totalMessagesSynced,
                });
              } catch (error) {
                this.logger.error(
                  { userId, phoneNumber, error },
                  "Failed to complete sync status update after grace period",
                );
              }
            }, SYNC_COMPLETION_DELAY);
          }
        }
      } catch (error) {
        this.logger.error(
          { userId, phoneNumber, error },
          "Failed to process history sync",
        );
      }
    });

    // Handle contacts updates (these may fire even without full history sync)
    socket.ev.on("contacts.upsert", async (contacts) => {
      this.logger.info(
        {
          userId,
          phoneNumber,
          count: contacts?.length || 0,
        },
        "Contacts upsert event received",
      );

      if (contacts && contacts.length > 0) {
        const count = await this.processSyncedContacts(
          userId,
          phoneNumber,
          contacts,
        );
        totalContactsSynced += count;

        // Only emit sync event if we have substantial data (more than 10 contacts)
        // This prevents the misleading "5 contacts" display
        if (contacts.length > 10) {
          // Update sync progress in database
          if (this.connectionStateManager) {
            await this.connectionStateManager.updateSyncProgress(
              userId,
              phoneNumber,
              totalContactsSynced,
              totalMessagesSynced,
              false,
            );
          }

          // Update phone number status for UI
          await this.updatePhoneNumberStatus(
            userId,
            phoneNumber,
            "importing_contacts",
          );

          // Emit sync event for UI
          this.emit("contacts-synced", {
            userId,
            phoneNumber,
            count: contacts.length,
          });
        } else {
          this.logger.info(
            {
              userId,
              phoneNumber,
              count: contacts.length,
            },
            "Small initial contacts batch, not emitting to UI yet",
          );
        }
      }
    });

    // Handle chats updates
    socket.ev.on("chats.upsert", async (chats) => {
      this.logger.info(
        {
          userId,
          phoneNumber,
          count: chats?.length || 0,
        },
        "Chats upsert event received",
      );

      if (chats && chats.length > 0) {
        await this.processSyncedChats(userId, phoneNumber, chats, socket);
      }
    });

    // Handle contact updates
    socket.ev.on("contacts.update", async (updates) => {
      this.logger.info(
        {
          userId,
          phoneNumber,
          count: updates?.length || 0,
        },
        "Contacts update event received",
      );

      for (const update of updates || []) {
        if (update.id) {
          const contactNumber = update.id.replace("@s.whatsapp.net", "");
          const contactRef = this.firestore
            .collection("users")
            .doc(userId)
            .collection("contacts")
            .doc(contactNumber);

          await contactRef.set(
            {
              phone_number: contactNumber,
              whatsapp_name: update.name || update.notify || null,
              updated_at: new Date(),
            },
            { merge: true },
          );
        }
      }
    });
  }

  /**
   * Handle QR code generation
   */
  private async handleQRCode(userId: string, phoneNumber: string, qr: string) {
    try {
      // Emit QR code event IMMEDIATELY for WebSocket clients (don't wait for Firestore)
      this.emit("qr-generated", {
        userId,
        phoneNumber,
        qr,
      });

      this.logger.info(
        { userId, phoneNumber, qrLength: qr.length },
        "QR code event emitted to WebSocket clients",
      );

      // Update phone number status for UI immediately
      await this.updatePhoneNumberStatus(userId, phoneNumber, "qr_pending");

      // Store QR code in Firestore (async, don't block)
      const sessionRef = this.firestore
        .collection("users")
        .doc(userId)
        .collection("phone_numbers")
        .doc(phoneNumber);

      // Check if document exists before storing QR code
      sessionRef
        .get()
        .then((doc) => {
          if (!doc.exists) {
            this.logger.info(
              { userId, phoneNumber },
              "Phone number document doesn't exist (was deleted), skipping QR code storage",
            );
            return;
          }
          return sessionRef.update({
            qr_code: qr,
            status: "qr_pending",
            instance_url: this.config.instanceUrl,
            updated_at: new Date(),
          });
        })
        .catch((error) => {
          this.logger.error(
            { userId, phoneNumber, error },
            "Failed to store QR code in Firestore",
          );
        });
    } catch (error) {
      this.logger.error(
        { userId, phoneNumber, error },
        "Failed to handle QR code",
      );
      // Still try to emit the event even if there's an error
      this.emit("qr-generated", {
        userId,
        phoneNumber,
        qr,
      });
    }
  }

  /**
   * Handle incoming messages
   */
  private async handleIncomingMessage(
    userId: string,
    phoneNumber: string,
    message: any,
  ) {
    try {
      // Extract sender info
      const fromJid = message.key.remoteJid || "";
      const fromNumber = fromJid
        .replace("@s.whatsapp.net", "")
        .replace("@g.us", "");
      const isGroup = fromJid.includes("@g.us");

      // Extract message text
      const messageText = this.extractMessageText(message);

      // Log incoming message
      this.logger.info(
        {
          userId,
          phoneNumber,
          fromNumber,
          messageId: message.key.id,
          body: messageText,
          isGroup,
          timestamp: message.messageTimestamp,
        },
        "Incoming WhatsApp Web message received",
      );

      // Skip group messages
      if (isGroup) {
        this.logger.debug(
          { userId, phoneNumber, fromJid },
          "Skipping group message",
        );
        return;
      }

      // Skip special WhatsApp identifiers (status updates, broadcasts, etc.)
      if (this.isSpecialWhatsAppIdentifier(fromJid)) {
        this.logger.debug(
          { userId, phoneNumber, fromJid, fromNumber },
          "Skipping special WhatsApp identifier (status/broadcast/newsletter)",
        );
        return;
      }

      // Format phone numbers
      const formattedFromPhone = fromNumber.startsWith("+")
        ? fromNumber
        : `+${fromNumber}`;
      const formattedToPhone = phoneNumber.startsWith("+")
        ? phoneNumber
        : `+${phoneNumber}`;

      // Handle media if present (downloads from WhatsApp, uploads to Cloud Storage)
      const mediaInfo = await this.handleMediaMessage(
        message,
        userId,
        phoneNumber,
      );

      // Build normalized message payload for Cloud Function
      const messagePayload = {
        userId: userId,
        messageSid: message.key.id,
        toPhoneNumber: formattedToPhone,
        fromPhoneNumber: formattedFromPhone,
        status: "received",
        mediaUrl: mediaInfo.media_url || undefined,
        mediaContentType: mediaInfo.media_content_type || undefined,
        body: messageText,
        timestamp: message.messageTimestamp * 1000, // Convert to milliseconds
        messageType: mediaInfo.type,
      };

      // Call HTTP Cloud Function endpoint
      const functionUrl =
        process.env.INCOMING_WHATSAPP_WEB_MESSAGE_URL ||
        `https://${process.env.FIREBASE_REGION || "europe-central2"}-${process.env.GOOGLE_CLOUD_PROJECT || "whatzaidev"}.cloudfunctions.net/incomingWhatsAppWebMessage`;

      const response = await fetch(functionUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(messagePayload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const result = (await response.json()) as {
        messageId: string;
        success: boolean;
        message: string;
      };

      this.logger.info(
        {
          userId,
          phoneNumber,
          fromNumber: formattedFromPhone,
          messageId: message.key.id,
          pubsubMessageId: result.messageId,
        },
        "WhatsApp Web message sent to Cloud Function successfully",
      );
    } catch (error) {
      this.logger.error(
        { userId, phoneNumber, error },
        "Failed to send message to Cloud Function",
      );
    }
  }

  /**
   * Handle outgoing messages (both API-sent and manual from phone)
   */
  private async handleOutgoingMessage(
    userId: string,
    phoneNumber: string,
    message: any,
  ) {
    try {
      // Check if this was sent via our API
      const isApiSent = this.sentMessageIds.has(message.key.id);

      if (isApiSent) {
        // Message sent via DM Champ - already processed
        this.logger.debug(
          {
            userId,
            phoneNumber,
            messageId: message.key.id,
          },
          "Skipping API-sent message (already processed)",
        );
        return;
      }

      // This is a MANUAL message sent from phone!
      const toJid = message.key.remoteJid || "";
      const toNumber = toJid
        .replace("@s.whatsapp.net", "")
        .replace("@g.us", "");
      const isGroup = toJid.includes("@g.us");

      // Skip group messages
      if (isGroup) {
        this.logger.debug(
          { userId, phoneNumber, toJid },
          "Skipping group message",
        );
        return;
      }

      // Extract message text
      const messageText = this.extractMessageText(message);

      // Log manual message detection
      this.logger.info(
        {
          userId,
          phoneNumber,
          toNumber,
          messageId: message.key.id,
          body: messageText,
          manual: true,
          timestamp: message.messageTimestamp,
        },
        "Manual WhatsApp message detected",
      );

      // Format phone numbers
      const formattedToPhone = toNumber.startsWith("+")
        ? toNumber
        : `+${toNumber}`;
      const formattedFromPhone = phoneNumber.startsWith("+")
        ? phoneNumber
        : `+${phoneNumber}`;

      // Get or create contact
      const userRef = this.firestore.collection("users").doc(userId);
      const currentTimestamp = admin.firestore.Timestamp.now();

      const existingContacts = await this.firestore
        .collection("contacts")
        .where("user", "==", userRef)
        .where("phone_number", "==", formattedToPhone)
        .limit(1)
        .get();

      let contactRef;
      if (existingContacts.empty) {
        // Create new contact for manual conversation
        const newContactData = {
          created_at: currentTimestamp,
          email: "unknown@unknown.com",
          first_name: "Unknown",
          last_name: "Unknown",
          phone_number: formattedToPhone,
          user: userRef,
          last_modified_at: currentTimestamp,
          last_activity_at: currentTimestamp,
          channel: "whatsapp_web",

          // CRITICAL: Pause AI for manual messages
          is_bot_active: false,
          bot_currently_responding: false,
          bot_waiting_for_contact_to_finish_responding: true,

          has_had_activity: true,
          bot_message_count: 0,
          chat_window_closes_at: currentTimestamp,
          is_chat_window_open: true,
          mark_chat_closed: false,
          follow_up_exhausted: false,
          chat_concluded: false,
          stop_and_respond: false,
          interrupted: false,
          do_not_disturb: false,
          do_not_disturb_reason: null,
          process_incoming_message_cloud_task_name: null,
          credits_used: 0,
          last_updated_by: "whatsapp_web_manual",
          lists: [],
          campaigns: [],
          tags: [],
        };

        const newContactRef = await this.firestore
          .collection("contacts")
          .add(newContactData);
        contactRef = newContactRef;

        this.logger.info(
          { userId, phoneNumber, toNumber: formattedToPhone },
          "Created new contact from manual message",
        );
      } else {
        contactRef = existingContacts.docs[0].ref;

        // PAUSE AI for existing contact
        await contactRef.update({
          is_bot_active: false,
          bot_currently_responding: false,
          bot_waiting_for_contact_to_finish_responding: true,
          last_manual_message_at: currentTimestamp,
          last_activity_at: currentTimestamp,
          last_modified_at: currentTimestamp,
          has_had_activity: true,
          channel: "whatsapp_web",
        });
      }

      // Store the manual message
      // Handle media if present
      const mediaInfo = await this.handleMediaMessage(
        message,
        userId,
        phoneNumber,
      );

      const messageData = {
        // Core fields
        message_sid: message.key.id,
        from_phone_number: formattedFromPhone,
        to_phone_number: formattedToPhone,
        body: messageText,
        direction: "outbound",
        status: "sent",
        channel: "whatsapp_web",
        timestamp: admin.firestore.Timestamp.fromMillis(
          message.messageTimestamp * 1000,
        ),
        created_at: currentTimestamp,

        // CRITICAL FLAGS for manual messages
        bot_reply: false, // NOT a bot message
        sent_manually: true, // Sent from phone
        sent_via_api: false, // NOT sent via DM Champ
        synced_from_history: false, // Not from history

        // No credits for manual messages
        credits_used: 0,

        // Standard fields
        media_url: mediaInfo.media_url,
        media_content_type: mediaInfo.media_content_type,
        completion_tokens: 0,
        prompt_tokens: 0,
        total_tokens: 0,
        role: "",
        tool_call_id: "",
        type: mediaInfo.type,
        content_sid: null,
        content_variables: null,
        error_code: null,
        error_message: null,
        price: null,
        price_unit: null,
        name: null,
        args: null,
        openai_chat_completion_id: null,
        chunk_index: 0,
        is_last_chunk: null,
        from_instagram_id: "",
        to_instagram_id: "",
        responded: false,
        responding: false,
        first_message_of_the_day: false,
      };

      // Check for duplicate message before adding
      const existingMessage = await contactRef
        .collection("messages")
        .where("message_sid", "==", message.key.id)
        .limit(1)
        .get();

      if (existingMessage.empty) {
        // Add message to contact's messages subcollection
        const messageRef = await contactRef
          .collection("messages")
          .add(messageData);

        // Update last_message
        await contactRef.update({
          last_message: {
            direction: "outbound",
            body: messageText,
            status: "sent",
            timestamp: currentTimestamp,
            messageRef: messageRef,
            manual: true, // Flag as manual
          },
          last_message_timestamp: currentTimestamp,
        });

        this.logger.info(
          {
            userId,
            phoneNumber,
            toNumber: formattedToPhone,
            messageId: message.key.id,
            aiPaused: true,
            creditsUsed: 0,
          },
          "Manual message stored, AI paused, no credits deducted",
        );
      } else {
        this.logger.debug(
          {
            userId,
            phoneNumber,
            messageId: message.key.id,
            toNumber: formattedToPhone,
          },
          "Skipped duplicate manual outgoing message",
        );
        return; // Exit early for duplicates
      }

      // Emit event for UI updates
      this.emit("manual-message-stored", {
        userId,
        phoneNumber,
        messageId: message.key.id,
        toNumber: formattedToPhone,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error(
        { userId, phoneNumber, error },
        "Failed to handle outgoing message",
      );
    }
  }

  /**
   * Handle message status updates
   */
  private async handleMessageUpdate(
    userId: string,
    phoneNumber: string,
    update: any,
  ) {
    try {
      await this.publishEvent("message-update", {
        userId,
        phoneNumber,
        messageId: update.key.id,
        status: update.update?.status,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error(
        { userId, phoneNumber, error },
        "Failed to handle message update",
      );
    }
  }

  /**
   * Handle presence updates
   */
  private async handlePresenceUpdate(
    userId: string,
    phoneNumber: string,
    presence: any,
  ) {
    try {
      await this.publishEvent("presence-update", {
        userId,
        phoneNumber,
        jid: presence.id,
        presence: presence.presences,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error(
        { userId, phoneNumber, error },
        "Failed to handle presence update",
      );
    }
  }

  /**
   * Handle typing indicators
   */
  private async handleTypingIndicator(
    userId: string,
    phoneNumber: string,
    chatId: string,
    isTyping: boolean,
  ) {
    try {
      await this.publishEvent("typing-indicator", {
        userId,
        phoneNumber,
        chatId,
        isTyping,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error(
        { userId, phoneNumber, error },
        "Failed to handle typing indicator",
      );
    }
  }

  /**
   * Create or find existing import list for WhatsApp Web contacts
   */
  private async createImportList(
    userId: string,
    phoneNumber: string,
  ): Promise<DocumentReference | null> {
    try {
      const userRef = this.firestore.collection("users").doc(userId);
      // Use a consistent naming pattern based on phone number (no timestamp)
      const listName = `WhatsApp Import - ${phoneNumber}`;

      // Check if a list with this name already exists for this user
      const existingLists = await this.firestore
        .collection("lists")
        .where("user", "==", userRef)
        .where("name", "==", listName)
        .limit(1)
        .get();

      if (!existingLists.empty) {
        const existingList = existingLists.docs[0];
        const existingData = existingList.data();

        // Check if it's a soft-deleted list we can reactivate
        if (
          existingData.status === "deleted" ||
          existingData.status === "archived"
        ) {
          this.logger.info(
            {
              userId,
              phoneNumber,
              listId: existingList.id,
              listName,
              previousStatus: existingData.status,
            },
            "Reactivating soft-deleted/archived import list for WhatsApp Web sync",
          );

          // Reactivate the soft-deleted list
          await existingList.ref.update({
            status: "live",
            last_modified_at: admin.firestore.Timestamp.now(),
            last_updated_by: "whatsapp_web_sync",
            reactivated_at: admin.firestore.Timestamp.now(),
            contacts: [], // Clear old contacts as they might be stale
          });

          return existingList.ref;
        }

        // Reuse existing live list
        this.logger.info(
          {
            userId,
            phoneNumber,
            listId: existingList.id,
            listName,
          },
          "Reusing existing import list for WhatsApp Web sync",
        );

        // Update the last_modified_at timestamp
        await existingList.ref.update({
          last_modified_at: admin.firestore.Timestamp.now(),
          last_updated_by: "whatsapp_web_sync",
        });

        return existingList.ref;
      }

      // Create new list if none exists
      const listData = {
        contacts: [], // Will be populated as contacts are imported
        created_at: admin.firestore.Timestamp.now(),
        last_modified_at: admin.firestore.Timestamp.now(),
        last_updated_by: "whatsapp_web_sync",
        name: listName,
        user: userRef,
        campaigns: [],
        status: "live",
        import_source: "whatsapp_web",
        phone_number: phoneNumber, // Store the phone number for reference
      };

      const listRef = await this.firestore.collection("lists").add(listData);

      this.logger.info(
        {
          userId,
          phoneNumber,
          listId: listRef.id,
          listName,
        },
        "Created new import list for WhatsApp Web sync",
      );

      return listRef;
    } catch (error) {
      this.logger.error(
        { userId, phoneNumber, error },
        "Failed to create or find import list",
      );
      return null;
    }
  }

  /**
   * Extract message text with better media type labels
   */
  private extractMessageText(message: any): string {
    // Check for text content first
    if (message.message?.conversation) {
      return message.message.conversation;
    }
    if (message.message?.extendedTextMessage?.text) {
      return message.message.extendedTextMessage.text;
    }

    // Check for media with captions
    // Return caption if exists, otherwise empty string (Cloud Functions will add descriptive prefix)
    if (message.message?.imageMessage) {
      return message.message.imageMessage.caption || "";
    }
    if (message.message?.videoMessage) {
      return message.message.videoMessage.caption || "";
    }
    if (message.message?.audioMessage) {
      // Audio messages don't have captions, return empty string
      return "";
    }
    if (message.message?.documentMessage) {
      // Keep document filename for context
      const fileName = message.message.documentMessage.fileName || "";
      return fileName ? `[Document: ${fileName}]` : "";
    }
    if (message.message?.stickerMessage) {
      return "[Sticker]";
    }
    if (message.message?.locationMessage) {
      return "[Location]";
    }
    if (message.message?.contactMessage) {
      return "[Contact]";
    }

    // Default fallback
    return "[Media]";
  }

  /**
   * Handle media message - download and upload to Cloud Storage
   */
  private async handleMediaMessage(
    message: any,
    userId: string,
    phoneNumber: string,
  ): Promise<{
    media_url: string | null;
    media_content_type: string | null;
    type: string;
  }> {
    try {
      // Check if message has media
      const messageContent = message.message;
      if (!messageContent) {
        return { media_url: null, media_content_type: null, type: "text" };
      }

      let mediaType: string | null = null;
      let mimetype: string | null = null;

      // Detect media type and mimetype
      if (messageContent.imageMessage) {
        mediaType = "image";
        mimetype = messageContent.imageMessage.mimetype || "image/jpeg";
      } else if (messageContent.videoMessage) {
        mediaType = "video";
        mimetype = messageContent.videoMessage.mimetype || "video/mp4";
      } else if (messageContent.audioMessage) {
        mediaType = "audio";
        mimetype = messageContent.audioMessage.mimetype || "audio/ogg";
      } else if (messageContent.documentMessage) {
        mediaType = "document";
        mimetype =
          messageContent.documentMessage.mimetype || "application/octet-stream";
      } else if (messageContent.stickerMessage) {
        mediaType = "sticker";
        mimetype = "image/webp";
      } else {
        // Not a media message
        return { media_url: null, media_content_type: null, type: "text" };
      }

      this.logger.info(
        {
          userId,
          phoneNumber,
          messageId: message.key.id,
          mediaType,
          mimetype,
        },
        "Processing media message",
      );

      // Download media from WhatsApp
      const mediaBuffer = (await downloadMediaMessage(
        message,
        "buffer",
        {},
      )) as Buffer;

      if (!mediaBuffer) {
        this.logger.warn(
          {
            userId,
            phoneNumber,
            messageId: message.key.id,
            mediaType,
          },
          "Failed to download media from WhatsApp",
        );
        return {
          media_url: null,
          media_content_type: mimetype,
          type: mediaType,
        };
      }

      // Upload to Cloud Storage
      const uploadResult = await this.mediaService.uploadMedia(
        {
          buffer: mediaBuffer,
          mimetype: mimetype || "application/octet-stream",
          size: mediaBuffer.length,
          originalname: `whatsapp_${mediaType}_${message.key.id}`,
        },
        userId,
        phoneNumber,
      );

      this.logger.info(
        {
          userId,
          phoneNumber,
          messageId: message.key.id,
          mediaType,
          mediaUrl: uploadResult.url,
          fileSize: uploadResult.size,
        },
        "Media uploaded successfully",
      );

      return {
        media_url: uploadResult.url,
        media_content_type: mimetype,
        type: mediaType,
      };
    } catch (error) {
      this.logger.error(
        {
          error,
          userId,
          phoneNumber,
          messageId: message.key.id,
        },
        "Failed to process media message",
      );

      // Return basic info even if upload fails
      const messageContent = message.message;
      let mediaType = "text";
      let mimetype: string | null = null;

      if (messageContent?.imageMessage) {
        mediaType = "image";
        mimetype = messageContent.imageMessage.mimetype;
      } else if (messageContent?.videoMessage) {
        mediaType = "video";
        mimetype = messageContent.videoMessage.mimetype;
      } else if (messageContent?.audioMessage) {
        mediaType = "audio";
        mimetype = messageContent.audioMessage.mimetype;
      } else if (messageContent?.documentMessage) {
        mediaType = "document";
        mimetype = messageContent.documentMessage.mimetype;
      }

      return { media_url: null, media_content_type: mimetype, type: mediaType };
    }
  }

  /**
   * Check if messages represent a real conversation
   */
  private isRealConversation(messages: any[]): boolean {
    // Check if we have actual text messages
    const hasTextMessages = messages.some(
      (msg) =>
        msg.message?.conversation || msg.message?.extendedTextMessage?.text,
    );

    // Check if we have media with meaningful captions
    const hasMediaWithCaptions = messages.some(
      (msg) =>
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption,
    );

    // Check if we have back-and-forth conversation (messages from both sides)
    const hasInbound = messages.some((msg) => !msg.key.fromMe);
    const hasOutbound = messages.some((msg) => msg.key.fromMe);
    const hasBackAndForth = hasInbound && hasOutbound;

    // Check if we have multiple messages (more than just a single media)
    const hasMultipleMessages = messages.length > 1;

    // It's a real conversation if:
    // - Has text messages, OR
    // - Has media with captions, OR
    // - Has back-and-forth messages, OR
    // - Has multiple messages (not just a single [Media])
    return (
      hasTextMessages ||
      hasMediaWithCaptions ||
      hasBackAndForth ||
      (hasMultipleMessages && messages.length > 2)
    );
  }

  /**
   * Extract first and last name from a full name string
   * Handles titles like Dr., Mr., Mrs., etc. and multi-word names
   */
  private extractNames(fullName: string | null): {
    firstName: string;
    lastName: string;
  } {
    if (!fullName || fullName.trim() === "") {
      return { firstName: "Unknown", lastName: "Unknown" };
    }

    const name = fullName.trim();

    // Common titles to skip
    const titles = [
      "Dr.",
      "Dr",
      "Mr.",
      "Mr",
      "Mrs.",
      "Mrs",
      "Ms.",
      "Ms",
      "Prof.",
      "Prof",
    ];

    // Split the name into parts
    const parts = name.split(/\s+/).filter((part) => part.length > 0);

    // Remove title if present
    if (
      parts.length > 0 &&
      titles.some((title) => parts[0].toLowerCase() === title.toLowerCase())
    ) {
      parts.shift();
    }

    if (parts.length === 0) {
      return { firstName: "Unknown", lastName: "Unknown" };
    } else if (parts.length === 1) {
      // Only one name part
      return { firstName: parts[0], lastName: "Unknown" };
    } else if (parts.length === 2) {
      // Two parts: first and last
      return { firstName: parts[0], lastName: parts[1] };
    } else {
      // Three or more parts
      // Check for common middle name indicators or compound last names
      const lowerParts = parts.map((p) => p.toLowerCase());

      // Common particles that indicate start of last name
      const particles = [
        "van",
        "von",
        "de",
        "del",
        "der",
        "den",
        "la",
        "le",
        "bin",
        "ibn",
      ];

      // Find if any particle exists
      let lastNameStartIndex = -1;
      for (let i = 1; i < parts.length - 1; i++) {
        if (particles.includes(lowerParts[i])) {
          lastNameStartIndex = i;
          break;
        }
      }

      if (lastNameStartIndex !== -1) {
        // Found a particle, everything from there is last name
        return {
          firstName: parts.slice(0, lastNameStartIndex).join(" "),
          lastName: parts.slice(lastNameStartIndex).join(" "),
        };
      } else {
        // No particle found, assume first word is first name, rest is last name
        return {
          firstName: parts[0],
          lastName: parts.slice(1).join(" "),
        };
      }
    }
  }

  /**
   * Process synced contacts from history
   */
  private async processSyncedContacts(
    userId: string,
    phoneNumber: string,
    contacts: any[],
  ): Promise<number> {
    try {
      let syncedCount = 0;
      const userRef = this.firestore.collection("users").doc(userId);
      const currentTimestamp = admin.firestore.Timestamp.now();

      for (const contact of contacts) {
        const contactNumber = contact.id?.replace("@s.whatsapp.net", "") || "";

        // Skip invalid contacts
        if (!contactNumber || contactNumber === phoneNumber) continue;

        // Use consistent phone number normalization
        const formattedPhone = formatPhoneNumberSafe(contactNumber);
        if (!formattedPhone) {
          this.logger.debug(
            { userId, phoneNumber, rawContactNumber: contactNumber },
            "Skipping contact - invalid phone number format",
          );
          continue;
        }

        // Store contact info for later use when creating contacts from messages
        const contactKey = `${userId}-${formattedPhone}`;
        this.syncedContactInfo.set(contactKey, {
          name: contact.name,
          notify: contact.notify,
          verifiedName: contact.verifiedName,
        });

        // Check if contact already exists for this user
        const existingContacts = await this.firestore
          .collection("contacts")
          .where("user", "==", userRef)
          .where("phone_number", "==", formattedPhone)
          .limit(1)
          .get();

        if (!existingContacts.empty) {
          // Update existing contact with WhatsApp info
          const existingDoc = existingContacts.docs[0];
          const existingData = existingDoc.data();

          // Extract first and last name from WhatsApp name if current name is Unknown
          const { firstName, lastName } = this.extractNames(
            contact.name || contact.notify,
          );

          await existingDoc.ref.update({
            whatsapp_name: contact.name || contact.notify || null,
            first_name:
              existingData.first_name === "Unknown" || !existingData.first_name
                ? firstName || "Unknown"
                : existingData.first_name,
            last_name:
              existingData.last_name === "Unknown" || !existingData.last_name
                ? lastName || "Unknown"
                : existingData.last_name,
            last_modified_at: currentTimestamp,
            last_updated_by: "whatsapp_web_sync",
            channel: "whatsapp_web",
          });
          syncedCount++;
        } else {
          // Skip creating new contacts without chat history
          // Contacts will be created when actual messages are received
          this.logger.debug(
            { userId, phoneNumber, contactNumber: formattedPhone },
            "Skipping contact creation - no chat history",
          );
        }

        // Log progress every 100 contacts
        if (syncedCount % 100 === 0) {
          this.logger.info(
            { userId, phoneNumber, syncedCount },
            "Contacts sync progress",
          );

          // Update sync progress in database every 100 contacts for UI polling
          if (this.connectionStateManager) {
            await this.connectionStateManager.updateSyncProgress(
              userId,
              phoneNumber,
              syncedCount,
              0, // messages count not available in this context
              false,
            );
          }
        }
      }

      this.logger.info(
        { userId, phoneNumber, totalSynced: syncedCount },
        "Contacts sync completed",
      );

      // Update sync progress in database
      if (this.connectionStateManager) {
        await this.connectionStateManager.updateSyncProgress(
          userId,
          phoneNumber,
          syncedCount,
          0, // messages count not available here
          false,
        );
      }

      // Emit event for UI updates
      this.emit("contacts-synced", {
        userId,
        phoneNumber,
        count: syncedCount,
      });

      return syncedCount;
    } catch (error) {
      this.logger.error(
        { userId, phoneNumber, error },
        "Failed to process synced contacts",
      );
      return 0;
    }
  }

  /**
   * Process synced chats from history
   */
  private async processSyncedChats(
    userId: string,
    phoneNumber: string,
    chats: any[],
    socket?: any,
  ) {
    try {
      let processedCount = 0;
      const userRef = this.firestore.collection("users").doc(userId);
      const currentTimestamp = admin.firestore.Timestamp.now();

      // Get the import list reference if it exists
      const sessionKey = `${userId}-${phoneNumber}`;
      const importListRef = this.importListRefs.get(sessionKey);

      for (const chat of chats) {
        const chatJid = chat.id || "";
        const isGroup = chatJid.includes("@g.us");

        // Skip groups for now
        if (isGroup) continue;

        const contactNumber = chatJid.replace("@s.whatsapp.net", "");

        if (!contactNumber) continue;

        // Use consistent phone number normalization
        const formattedPhone = formatPhoneNumberSafe(contactNumber);
        if (!formattedPhone) {
          this.logger.debug(
            { userId, phoneNumber, rawContactNumber: contactNumber },
            "Skipping contact - invalid phone number format",
          );
          continue;
        }

        // Find or create contact in root collection
        const existingContacts = await this.firestore
          .collection("contacts")
          .where("user", "==", userRef)
          .where("phone_number", "==", formattedPhone)
          .limit(1)
          .get();

        let contactRef;

        if (!existingContacts.empty) {
          // Update existing contact with chat metadata
          contactRef = existingContacts.docs[0].ref;
          const existingData = existingContacts.docs[0].data();

          // Extract name from chat if current name is Unknown or empty
          const { firstName, lastName } = this.extractNames(chat.name || null);

          const updateData: any = {
            last_activity_at: chat.conversationTimestamp
              ? admin.firestore.Timestamp.fromMillis(
                  chat.conversationTimestamp * 1000,
                )
              : currentTimestamp,
            last_modified_at: currentTimestamp,
            has_had_activity: true,
            channel: "whatsapp_web",
            import_source: "whatsapp_web_sync",
            imported_at: currentTimestamp,
          };

          // Update names if they are currently Unknown, empty, or null
          if (
            (!existingData.first_name ||
              existingData.first_name === "Unknown" ||
              existingData.first_name === "") &&
            firstName !== "Unknown"
          ) {
            updateData.first_name = firstName;
          }
          if (
            (!existingData.last_name ||
              existingData.last_name === "Unknown" ||
              existingData.last_name === "") &&
            lastName !== "Unknown"
          ) {
            updateData.last_name = lastName;
          }

          // Add WhatsApp name if available
          if (chat.name) {
            updateData.whatsapp_name = chat.name;
          }

          // Merge lists - add to import list if not already present
          if (importListRef) {
            const currentLists = existingData.lists || [];

            // Clean up any orphaned list references first
            const validLists = [];
            for (const listRef of currentLists) {
              if (listRef && listRef.id) {
                try {
                  const listDoc = await listRef.get();
                  if (!listDoc.exists) {
                    // List was hard-deleted from database
                    this.logger.debug(
                      {
                        userId,
                        contactPhone: formattedPhone,
                        listId: listRef.id,
                      },
                      "Removing reference to hard-deleted list from contact in chat sync",
                    );
                  } else if (listDoc.data()?.status !== "live") {
                    // List is soft-deleted or archived
                    this.logger.debug(
                      {
                        userId,
                        contactPhone: formattedPhone,
                        listId: listRef.id,
                        status: listDoc.data()?.status,
                      },
                      "Removing reference to soft-deleted/archived list from contact in chat sync",
                    );
                  } else {
                    // List exists and is live
                    validLists.push(listRef);
                  }
                } catch (error) {
                  // Error accessing list (permissions or other issues)
                  this.logger.debug(
                    {
                      userId,
                      contactPhone: formattedPhone,
                      listId: listRef.id,
                      error,
                    },
                    "Removing inaccessible list reference from contact in chat sync",
                  );
                }
              }
            }

            // Check if import list is already in valid lists
            const hasImportList = validLists.some(
              (listRef: any) => listRef.id === importListRef.id,
            );

            if (!hasImportList) {
              validLists.push(importListRef);
              this.logger.info(
                {
                  userId,
                  phoneNumber: formattedPhone,
                  listId: importListRef.id,
                },
                "Adding existing contact to import list from chat sync",
              );
            }

            // Update lists array with cleaned up references
            updateData.lists = validLists;
          }

          // Preserve important fields
          updateData.tags = existingData.tags || updateData.tags || [];
          updateData.campaigns =
            existingData.campaigns || updateData.campaigns || [];

          await contactRef.update(updateData);

          this.logger.info(
            {
              userId,
              phoneNumber: formattedPhone,
              fieldsUpdated: Object.keys(updateData),
            },
            "Updated existing contact from chat sync with merge logic",
          );
        } else {
          // Don't create new contact here - will be created when messages arrive
          // Store chat metadata for later use when creating contact from messages
          this.logger.debug(
            {
              userId,
              phoneNumber: formattedPhone,
              chatName: chat.name,
              conversationTimestamp: chat.conversationTimestamp,
            },
            "Skipping contact creation in chat sync - will create from messages",
          );

          // Store chat metadata temporarily for use in message processing
          const chatMetadataKey = `${userId}-${formattedPhone}`;
          this.pendingChatMetadata.set(chatMetadataKey, {
            name: chat.name,
            conversationTimestamp: chat.conversationTimestamp,
            importListRef,
          });
        }

        processedCount++;

        // If socket is provided, try to fetch message history for this chat
        if (socket && chat.conversationTimestamp && processedCount < 10) {
          // Limit to first 10 chats for testing
          try {
            // Create a proper message key for this chat
            const lastMessageKey: WAMessageKey = {
              remoteJid: chatJid,
              id: undefined as any, // Let Baileys handle the ID
              fromMe: false,
            };

            this.logger.info(
              {
                userId,
                phoneNumber,
                chatJid,
                contactNumber: formattedPhone,
              },
              "Attempting to fetch message history for chat",
            );

            // Try to fetch messages for this specific chat
            // This should trigger messaging-history.set event
            const historyId = await socket.fetchMessageHistory(
              50, // Number of messages to fetch
              lastMessageKey, // Message key with chat JID
              chat.conversationTimestamp * 1000, // Convert to milliseconds if needed
            );

            this.logger.info(
              {
                userId,
                phoneNumber,
                chatJid,
                historyId,
              },
              "Message history fetch request sent for chat",
            );

            // Emit progress event
            this.emit("sync:progress", {
              userId,
              phoneNumber,
              type: "chat_history_requested",
              chatJid,
              timestamp: new Date().toISOString(),
            });
          } catch (error) {
            this.logger.debug(
              {
                userId,
                phoneNumber,
                chatJid,
                error: error instanceof Error ? error.message : error,
              },
              "Could not fetch history for chat - this is expected for some chats",
            );
          }
        }
      }

      this.logger.info(
        { userId, phoneNumber, totalProcessed: processedCount },
        "Chats sync completed",
      );
    } catch (error) {
      this.logger.error(
        { userId, phoneNumber, error },
        "Failed to process synced chats",
      );
    }
  }

  /**
   * Process synced messages from history
   */
  private async processSyncedMessages(
    userId: string,
    phoneNumber: string,
    messages: any[],
  ): Promise<number> {
    try {
      this.logger.info(
        {
          userId,
          phoneNumber,
          totalMessages: messages.length,
          firstMessage: messages[0]
            ? {
                id: messages[0].key?.id,
                remoteJid: messages[0].key?.remoteJid,
                fromMe: messages[0].key?.fromMe,
                timestamp: messages[0].messageTimestamp,
              }
            : null,
        },
        "Starting to process synced messages",
      );

      let syncedCount = 0;
      const userRef = this.firestore.collection("users").doc(userId);
      const currentTimestamp = admin.firestore.Timestamp.now();

      // Get the import list reference if it exists
      const sessionKey = `${userId}-${phoneNumber}`;
      const importListRef = this.importListRefs.get(sessionKey);

      // Initialize deduplication cache for this session if not exists
      if (!this.processedContactsCache.has(sessionKey)) {
        this.processedContactsCache.set(sessionKey, new Set<string>());
        this.logger.info(
          { userId, phoneNumber },
          "Initialized deduplication cache for import session",
        );
      }
      const processedContacts = this.processedContactsCache.get(sessionKey)!;

      // Group messages by contact
      const messagesByContact = new Map<string, any[]>();

      for (const msg of messages) {
        const fromJid = msg.key?.remoteJid || "";
        const isGroup = fromJid.includes("@g.us");

        // Skip groups for now
        if (isGroup) continue;

        const contactNumber = fromJid.replace("@s.whatsapp.net", "");
        if (!contactNumber) continue;

        // Use consistent phone number normalization
        const formattedContactPhone = formatPhoneNumberSafe(contactNumber);
        if (!formattedContactPhone) {
          this.logger.debug(
            { userId, phoneNumber, rawContactNumber: contactNumber },
            "Skipping message - invalid contact phone number format",
          );
          continue;
        }

        // Group messages by contact
        if (!messagesByContact.has(formattedContactPhone)) {
          messagesByContact.set(formattedContactPhone, []);
        }
        messagesByContact.get(formattedContactPhone)!.push(msg);
      }

      // Process each contact's messages
      for (const [
        formattedContactPhone,
        contactMessages,
      ] of messagesByContact) {
        // Check if this contact was already processed in this session
        if (processedContacts.has(formattedContactPhone)) {
          this.logger.debug(
            {
              userId,
              phoneNumber,
              contactPhone: formattedContactPhone,
            },
            "Skipping contact - already processed in this import session",
          );
          continue;
        }

        // Check if this is a real conversation
        if (!this.isRealConversation(contactMessages)) {
          this.logger.debug(
            {
              userId,
              contactPhone: formattedContactPhone,
              messageCount: contactMessages.length,
              firstMessage: this.extractMessageText(contactMessages[0]),
            },
            "Skipping contact - not a real conversation",
          );
          continue;
        }

        const formattedUserPhone =
          formatPhoneNumberSafe(phoneNumber) || phoneNumber;

        // Find or create contact
        let contactRef;
        const existingContacts = await this.firestore
          .collection("contacts")
          .where("user", "==", userRef)
          .where("phone_number", "==", formattedContactPhone)
          .limit(1)
          .get();

        let isNewContact = false;
        let lastMessageRef: DocumentReference | null = null;
        let lastMessageData: any = null;

        if (!existingContacts.empty) {
          contactRef = existingContacts.docs[0].ref;
          const existingData = existingContacts.docs[0].data();

          // Prepare comprehensive update data for merging
          const updateData: any = {
            last_modified_at: currentTimestamp,
            has_had_activity: true,
            import_source: "whatsapp_web_sync",
            imported_at: currentTimestamp,
            channel: "whatsapp_web", // Ensure channel is set
          };

          // Update names if they're null/empty/Unknown
          if (
            !existingData.first_name ||
            existingData.first_name === "" ||
            existingData.first_name === "Unknown"
          ) {
            const contactKey = `${userId}-${formattedContactPhone}`;
            const syncedInfo = this.syncedContactInfo.get(contactKey);
            const pushName = contactMessages.find((m) => m.pushName)?.pushName;
            const nameToExtract =
              pushName ||
              syncedInfo?.notify ||
              syncedInfo?.name ||
              syncedInfo?.verifiedName ||
              null;
            const { firstName, lastName } = this.extractNames(nameToExtract);
            updateData.first_name = firstName || "Unknown";
            updateData.last_name = lastName || "Unknown";
            updateData.whatsapp_name =
              syncedInfo?.notify ||
              pushName ||
              syncedInfo?.verifiedName ||
              null;
          }

          // Merge lists - add to import list if not already present
          if (importListRef) {
            const currentLists = existingData.lists || [];

            // Clean up any orphaned list references first
            const validLists = [];
            for (const listRef of currentLists) {
              if (listRef && listRef.id) {
                // Check if list still exists and is live
                try {
                  const listDoc = await listRef.get();
                  if (!listDoc.exists) {
                    // List was hard-deleted from database
                    this.logger.debug(
                      {
                        userId,
                        contactPhone: formattedContactPhone,
                        listId: listRef.id,
                      },
                      "Removing reference to hard-deleted list from contact",
                    );
                  } else if (listDoc.data()?.status !== "live") {
                    // List is soft-deleted or archived
                    this.logger.debug(
                      {
                        userId,
                        contactPhone: formattedContactPhone,
                        listId: listRef.id,
                        status: listDoc.data()?.status,
                      },
                      "Removing reference to soft-deleted/archived list from contact",
                    );
                  } else {
                    // List exists and is live
                    validLists.push(listRef);
                  }
                } catch (error) {
                  // Error accessing list (permissions or other issues)
                  this.logger.debug(
                    {
                      userId,
                      contactPhone: formattedContactPhone,
                      listId: listRef.id,
                      error,
                    },
                    "Removing inaccessible list reference from contact",
                  );
                }
              }
            }

            // Check if import list is already in valid lists
            const hasImportList = validLists.some(
              (listRef: any) => listRef.id === importListRef.id,
            );

            if (!hasImportList) {
              validLists.push(importListRef);
              this.logger.info(
                {
                  userId,
                  phoneNumber: formattedContactPhone,
                  listId: importListRef.id,
                },
                "Adding existing contact to import list",
              );
            }

            // Update lists array with cleaned up references
            updateData.lists = validLists;
          }

          // Preserve important fields that shouldn't be overwritten
          updateData.tags = existingData.tags || updateData.tags || [];
          updateData.campaigns =
            existingData.campaigns || updateData.campaigns || [];

          // Update existing contact with merged data
          await contactRef.update(updateData);

          this.logger.info(
            {
              userId,
              phoneNumber: formattedContactPhone,
              fieldsUpdated: Object.keys(updateData),
            },
            "Merged existing contact with new WhatsApp sync data",
          );
        } else {
          // Create contact for real conversation
          isNewContact = true;

          // Try to get name from messages or pending metadata
          const chatMetadataKey = `${userId}-${formattedContactPhone}`;
          const pendingMetadata = this.pendingChatMetadata.get(chatMetadataKey);

          // Get synced contact info from contacts.upsert event
          const contactKey = `${userId}-${formattedContactPhone}`;
          const syncedInfo = this.syncedContactInfo.get(contactKey);

          // Check multiple sources for the contact name
          const pushName = contactMessages.find((m) => m.pushName)?.pushName;

          // Use the first available name source in priority order
          const nameToExtract =
            pushName ||
            syncedInfo?.notify ||
            syncedInfo?.name ||
            syncedInfo?.verifiedName ||
            pendingMetadata?.name ||
            null;

          // Store the actual WhatsApp display name
          const whatsappDisplayName =
            syncedInfo?.notify ||
            pushName ||
            syncedInfo?.verifiedName ||
            syncedInfo?.name ||
            null;

          const { firstName, lastName } = this.extractNames(nameToExtract);

          const newContactData = {
            created_at: currentTimestamp,
            email: "unknown@unknown.com",
            first_name: firstName && firstName !== "" ? firstName : "Unknown",
            last_name: lastName && lastName !== "" ? lastName : "Unknown",
            phone_number: formattedContactPhone,
            user: userRef,
            last_modified_at: currentTimestamp,
            channel: "whatsapp_web",
            is_bot_active: false,
            has_had_activity: true,
            bot_message_count: 0,
            chat_window_closes_at: currentTimestamp,
            is_chat_window_open: true,
            mark_chat_closed: false,
            bot_currently_responding: false,
            bot_waiting_for_contact_to_finish_responding: false,
            follow_up_exhausted: false,
            chat_concluded: false,
            stop_and_respond: false,
            interrupted: false,
            do_not_disturb: false,
            do_not_disturb_reason: null,
            process_incoming_message_cloud_task_name: null,
            credits_used: 0,
            last_updated_by: "whatsapp_web_sync",
            lists:
              pendingMetadata?.importListRef || importListRef
                ? [pendingMetadata?.importListRef || importListRef]
                : [],
            campaigns: [],
            tags: [],
            // Import tracking fields
            import_source: "whatsapp_web_sync",
            imported_at: currentTimestamp,
            imported_from_messages: true,
            whatsapp_name: whatsappDisplayName,
          };
          const newContactRef = await this.firestore
            .collection("contacts")
            .add(newContactData);
          contactRef = newContactRef;

          // Clean up pending metadata
          this.pendingChatMetadata.delete(chatMetadataKey);
        }

        // Add contact to import list if it's a new contact and list exists
        if (isNewContact && importListRef && contactRef) {
          await importListRef.update({
            contacts: admin.firestore.FieldValue.arrayUnion(contactRef),
            last_modified_at: currentTimestamp,
          });
        }

        // Process all messages for this contact with bulk deduplication
        // Get all existing message IDs for this contact in ONE query
        const existingMessagesSnapshot = await contactRef
          .collection("messages")
          .select("message_sid")
          .get();

        const existingMessageIds = new Set(
          existingMessagesSnapshot.docs.map((doc) => doc.data().message_sid),
        );

        // Filter out duplicates
        const newMessages = [];
        let skippedCount = 0;

        for (const msg of contactMessages) {
          if (!existingMessageIds.has(msg.key.id)) {
            newMessages.push(msg);
          } else {
            skippedCount++;
          }
        }

        if (skippedCount > 0) {
          this.logger.info(
            {
              userId,
              phoneNumber,
              contactPhone: formattedContactPhone,
              skippedCount,
              newCount: newMessages.length,
              totalAttempted: contactMessages.length,
            },
            "Skipped duplicate messages during bulk import",
          );
        }

        // Use batch writes for better performance
        let batch = this.firestore.batch();
        let batchCount = 0;
        let messagesAddedForContact = 0;

        for (const msg of newMessages) {
          // Extract message text with better labels
          const messageText = this.extractMessageText(msg);

          // Handle media if present
          const mediaInfo = await this.handleMediaMessage(
            msg,
            userId,
            phoneNumber,
          );

          // Create message as subcollection of contact
          const messageData = {
            // Core message fields
            message_sid: msg.key.id,
            from_phone_number: msg.key.fromMe
              ? formattedUserPhone
              : formattedContactPhone,
            to_phone_number: msg.key.fromMe
              ? formattedContactPhone
              : formattedUserPhone,
            body: messageText,
            direction: msg.key.fromMe ? "outbound" : "inbound",
            status: msg.key.fromMe ? "sent" : "received",
            channel: "whatsapp_web",
            timestamp: admin.firestore.Timestamp.fromMillis(
              msg.messageTimestamp * 1000,
            ),
            created_at: currentTimestamp,
            synced_from_history: true,

            // Media fields
            media_url: mediaInfo.media_url,
            media_content_type: mediaInfo.media_content_type,

            // Bot/AI fields
            bot_reply: false,
            completion_tokens: 0,
            prompt_tokens: 0,
            total_tokens: 0,
            role: "",
            tool_call_id: "",

            // Message metadata
            type: mediaInfo.type,
            content_sid: null,
            content_variables: null,
            error_code: null,
            error_message: null,
            price: null,
            price_unit: null,
            name: null,
            args: null,
            openai_chat_completion_id: null,
            chunk_index: 0,
            is_last_chunk: null,

            // Channel-specific fields
            from_instagram_id: "",
            to_instagram_id: "",

            // Response tracking
            responded: false,
            responding: false,
            first_message_of_the_day: false,
          };

          // Add to batch instead of individual add
          const messageDocRef = contactRef.collection("messages").doc();
          batch.set(messageDocRef, messageData);
          batchCount++;

          // Track the last message for this contact
          if (
            !lastMessageData ||
            msg.messageTimestamp > lastMessageData.messageTimestamp
          ) {
            lastMessageData = msg;
            lastMessageRef = messageDocRef;
          }

          messagesAddedForContact++;

          // Commit batch at Firestore limit (500 operations)
          if (batchCount >= 500) {
            await batch.commit();
            batch = this.firestore.batch();
            batchCount = 0;
          }
        }

        // Commit any remaining batch operations
        if (batchCount > 0) {
          await batch.commit();
        }

        // Increment syncedCount once per contact that had messages synced
        if (messagesAddedForContact > 0) {
          syncedCount++;
        }

        // After processing all messages for this contact, update the last_message field
        if (lastMessageData && lastMessageRef) {
          const lastMessageText = this.extractMessageText(lastMessageData);
          const lastMessageUpdate: any = {
            last_message: {
              direction: lastMessageData.key.fromMe ? "outbound" : "inbound",
              body: lastMessageText,
              status: lastMessageData.key.fromMe ? "sent" : "received",
              messageRef: lastMessageRef,
              timestamp: admin.firestore.Timestamp.fromMillis(
                lastMessageData.messageTimestamp * 1000,
              ),
            },
            last_message_timestamp: admin.firestore.Timestamp.fromMillis(
              lastMessageData.messageTimestamp * 1000,
            ),
            last_activity_at: admin.firestore.Timestamp.fromMillis(
              lastMessageData.messageTimestamp * 1000,
            ),
            has_had_activity: true,
          };

          if (!lastMessageData.key.fromMe) {
            lastMessageUpdate.last_incoming_message_at =
              admin.firestore.Timestamp.fromMillis(
                lastMessageData.messageTimestamp * 1000,
              );
          }

          await contactRef.update(lastMessageUpdate);
        }

        // Try to fetch profile picture if we have a socket connection
        const connection = this.connections.get(`${userId}-${phoneNumber}`);
        if (connection?.socket && contactRef) {
          try {
            const contactJid =
              formattedContactPhone.replace("+", "") + "@s.whatsapp.net";
            const profilePicUrl = await connection.socket.profilePictureUrl(
              contactJid,
              "image",
            );

            if (profilePicUrl) {
              await contactRef.update({
                avatar_url: profilePicUrl,
                avatar_fetched_at: currentTimestamp,
              });

              this.logger.debug(
                { userId, contactPhone: formattedContactPhone },
                "Profile picture fetched and saved",
              );
            }
          } catch (error) {
            // Profile picture might be private or unavailable
            this.logger.debug(
              { userId, contactPhone: formattedContactPhone, error },
              "Could not fetch profile picture",
            );
          }
        }

        // Add contact to deduplication cache after successful processing
        processedContacts.add(formattedContactPhone);
        this.logger.debug(
          {
            userId,
            phoneNumber,
            contactPhone: formattedContactPhone,
            cacheSize: processedContacts.size,
          },
          "Added contact to deduplication cache",
        );
      }

      this.logger.info(
        { userId, phoneNumber, totalSynced: syncedCount },
        "Messages sync completed",
      );

      // Emit event for UI updates
      this.emit("messages-synced", {
        userId,
        phoneNumber,
        count: syncedCount,
      });

      return syncedCount;
    } catch (error) {
      this.logger.error(
        { userId, phoneNumber, error },
        "Failed to process synced messages",
      );
      return 0;
    }
  }

  /**
   * Reconnect a connection
   */
  private async reconnect(
    userId: string,
    phoneNumber: string,
    attempt: number = 1,
  ) {
    const connectionKey = this.getConnectionKey(userId, phoneNumber);
    const maxAttempts = 5;
    const baseDelay = 5000;

    // Get existing connection's state BEFORE deleting
    const existingConnection = this.connections.get(connectionKey);
    const storedProxyCountry = existingConnection?.proxyCountry;
    const handshakeWasCompleted =
      existingConnection?.handshakeCompleted || false;

    // Remove old connection from pool (but keep auth state)
    this.connections.delete(connectionKey);

    // Skip attempt check for immediate reconnect (attempt = 0)
    if (attempt > 0 && attempt > maxAttempts) {
      this.logger.error(
        { userId, phoneNumber },
        "Max reconnection attempts reached, giving up",
      );
      await this.updateConnectionStatus(userId, phoneNumber, "failed");
      return;
    }

    // No delay for immediate reconnect (attempt = 0), otherwise exponential backoff
    if (attempt > 0) {
      const delay = baseDelay * Math.pow(2, attempt - 1);
      this.logger.info(
        { userId, phoneNumber, attempt, delay },
        "Waiting before reconnection attempt",
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    } else {
      this.logger.info(
        { userId, phoneNumber },
        "Immediate reconnection after pairing",
      );
    }

    try {
      // Try to reconnect with preserved proxy country
      // Note: Always use isRecovery=false for pairing reconnections to show import UI
      // We'll manually restore handshakeCompleted state after connection is created
      const success = await this.addConnection(
        userId,
        phoneNumber,
        storedProxyCountry,
        undefined, // countryCode
        false, // isRecovery - false to show import UI even after pairing
      );

      // Restore handshake completion state after successful reconnection
      if (success && handshakeWasCompleted) {
        const connectionKey = this.getConnectionKey(userId, phoneNumber);
        const connection = this.connections.get(connectionKey);
        if (connection) {
          connection.handshakeCompleted = true;
          this.logger.info(
            { userId, phoneNumber },
            "Restored handshake completion state after pairing reconnection",
          );
        }
      }

      if (!success) {
        // If addConnection failed, try again (only increment if not immediate reconnect)
        const nextAttempt = attempt === 0 ? 1 : attempt + 1;
        await this.reconnect(userId, phoneNumber, nextAttempt);
      }
    } catch (error) {
      this.logger.error(
        { userId, phoneNumber, attempt, error },
        "Reconnection attempt failed",
      );
      // Only increment attempt if not immediate reconnect
      const nextAttempt = attempt === 0 ? 1 : attempt + 1;
      await this.reconnect(userId, phoneNumber, nextAttempt);
    }
  }

  /**
   * Handle proxy errors
   */
  private async handleProxyError(userId: string, phoneNumber: string) {
    this.logger.info(
      { userId, phoneNumber },
      "Handling proxy error, rotating proxy",
    );

    // Rotate proxy
    await this.proxyManager.rotateProxy(userId, phoneNumber);

    // Reconnect with new proxy
    await this.reconnect(userId, phoneNumber);
  }

  /**
   * Update connection status in Firestore
   */
  private async updateConnectionStatus(
    userId: string,
    phoneNumber: string,
    status: string,
  ) {
    try {
      const sessionRef = this.firestore
        .collection("users")
        .doc(userId)
        .collection("phone_numbers")
        .doc(phoneNumber);

      // Check if document exists before updating
      const doc = await sessionRef.get();
      if (!doc.exists) {
        this.logger.info(
          { userId, phoneNumber, status },
          "Phone number document doesn't exist (was deleted), skipping connection status update to respect deletion",
        );
        return;
      }

      await sessionRef.update({
        status,
        instance_url: this.config.instanceUrl,
        updated_at: new Date(),
      });
    } catch (error) {
      this.logger.error(
        { userId, phoneNumber, error },
        "Failed to update connection status",
      );
    }
  }

  /**
   * Update phone number status - writes to nested whatsapp_web.status field
   */
  private async updatePhoneNumberStatus(
    userId: string,
    phoneNumber: string,
    status: string,
  ) {
    try {
      const connectionKey = this.getConnectionKey(userId, phoneNumber);
      const connection = this.connections.get(connectionKey);

      // DEFENSIVE CHECK: Skip status updates during handshake phase (before disconnect code 515)
      // Exception: Always allow qr_pending status (before handshake starts)
      if (
        connection &&
        !connection.handshakeCompleted &&
        status !== "qr_pending"
      ) {
        this.logger.info(
          {
            userId,
            phoneNumber,
            requestedStatus: status,
            handshakeCompleted: connection.handshakeCompleted,
          },
          "Skipping status update during handshake phase - will write after disconnect code 515",
        );
        return; // Skip Firestore write during handshake
      }

      // DEFENSIVE CHECK: Prevent "connected" or "connecting" status for first-time connections until sync completes
      // This prevents status regression during import phase
      if (
        (status === "connected" || status === "connecting") &&
        connection &&
        !connection.isRecovery &&
        !connection.syncCompleted
      ) {
        this.logger.warn(
          {
            userId,
            phoneNumber,
            requestedStatus: status,
            isRecovery: connection.isRecovery,
            syncCompleted: connection.syncCompleted,
          },
          "DEFENSIVE BLOCK: Preventing status change during sync - keeping import status",
        );
        // Override to importing_messages until sync is complete
        status = "importing_messages";
      }

      const phoneNumberRef = this.firestore
        .collection("users")
        .doc(userId)
        .collection("phone_numbers")
        .doc(phoneNumber);

      // Check if document exists before updating
      const phoneDoc = await phoneNumberRef.get();
      if (!phoneDoc.exists) {
        this.logger.info(
          { userId, phoneNumber, status },
          "Phone number document doesn't exist (was deleted), skipping status update to respect deletion",
        );
        return;
      }

      await phoneNumberRef.update({
        "whatsapp_web.status": status,
        "whatsapp_web.last_updated": admin.firestore.Timestamp.now(),
        updated_at: admin.firestore.Timestamp.now(),
      });

      this.logger.info(
        { userId, phoneNumber, status },
        "Updated phone number status in nested structure",
      );
    } catch (error) {
      this.logger.error(
        { userId, phoneNumber, status, error },
        "Failed to update phone number status",
      );
    }
  }

  /**
   * Publish events to Pub/Sub
   */
  private async publishEvent(eventType: string, data: any) {
    // Skip Pub/Sub in local development
    if (
      process.env.NODE_ENV === "development" ||
      process.env.FIRESTORE_EMULATOR_HOST
    ) {
      this.logger.debug(
        { eventType, data },
        "Event (local mode - not published to Pub/Sub)",
      );
      return;
    }

    try {
      const topic = this.pubsub.topic(`whatsapp-web-${eventType}`);
      await topic.publishMessage({ data: Buffer.from(JSON.stringify(data)) });
    } catch (error) {
      this.logger.error({ eventType, error }, "Failed to publish event");
    }
  }

  /**
   * Health check for connections
   */
  private startHealthCheck() {
    this.healthCheckTimer = setInterval(() => {
      for (const [_key, connection] of this.connections.entries()) {
        const idleTime = Date.now() - connection.lastActivity.getTime();

        // Remove connections idle for more than 90 days
        if (idleTime > 7776000000) {
          this.logger.info(
            { userId: connection.userId, phoneNumber: connection.phoneNumber },
            "Removing idle connection",
          );
          this.removeConnection(connection.userId, connection.phoneNumber);
        }

        // Check connection state
        if (connection.state.connection === "close") {
          this.reconnect(connection.userId, connection.phoneNumber);
        }
      }

      this.emit("health-check", {
        activeConnections: this.connections.size,
        memoryUsage: this.getMemoryUsage(),
      });
    }, this.config.healthCheckInterval);
  }

  /**
   * Cleanup old sessions
   */
  private startCleanup() {
    this.cleanupTimer = setInterval(() => {
      this.proxyManager.cleanupSessions();
      this.sessionManager.cleanupSessions();
    }, this.config.sessionCleanupInterval);
  }

  /**
   * Helper methods
   */
  private getConnectionKey(userId: string, phoneNumber: string): string {
    return `${userId}:${phoneNumber}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private formatJid(phoneNumber: string): string {
    // Use the phone number formatter to ensure proper E.164 format
    const jid = formatWhatsAppJid(phoneNumber);
    if (!jid) {
      // Fallback to basic cleaning if formatting fails
      this.logger.warn(
        { phoneNumber },
        "Failed to format phone number for JID, using fallback",
      );
      const cleaned = phoneNumber.replace(/\D/g, "");
      return `${cleaned}@s.whatsapp.net`;
    }
    return jid;
  }

  /**
   * Check if a JID is a special WhatsApp identifier that should not be processed
   * as a regular contact message (status updates, broadcasts, etc.)
   */
  private isSpecialWhatsAppIdentifier(jid: string): boolean {
    // Status updates (WhatsApp Stories)
    if (jid.includes("status@broadcast")) {
      return true;
    }

    // Broadcast lists
    if (jid.endsWith("@broadcast")) {
      return true;
    }

    // Temporary/ephemeral chats
    if (jid.includes("@lid")) {
      return true;
    }

    // Newsletter/channel messages
    if (jid.includes("@newsletter")) {
      return true;
    }

    return false;
  }

  private hasCapacity(): boolean {
    return this.connections.size < this.config.maxConnections;
  }

  /**
   * Get stored country for a phone number from Firestore
   * Reads from users/{userId}/phone_numbers subcollection
   */
  private async getStoredCountry(
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

      if (!phoneDoc.exists) {
        return undefined;
      }

      const data = phoneDoc.data();
      return data?.proxy_country || data?.country_code;
    } catch (error) {
      this.logger.debug(
        { error, userId, phoneNumber },
        "Failed to get stored country from Firestore",
      );
      return undefined;
    }
  }

  private getMemoryUsage(): number {
    const memUsage = process.memoryUsage();

    // In Cloud Run, get container memory limit from environment or use default
    const containerMemoryLimit = this.getContainerMemoryLimit();

    if (containerMemoryLimit > 0) {
      // Use RSS memory (actual memory usage) vs container limit
      return memUsage.rss / containerMemoryLimit;
    } else {
      // Fallback to heap usage ratio for local development
      return memUsage.heapUsed / memUsage.heapTotal;
    }
  }

  private getContainerMemoryLimit(): number {
    // Try to get from Cloud Run environment variables
    const cloudRunMemory = process.env.MEMORY_LIMIT;
    if (cloudRunMemory) {
      // Parse Cloud Run memory format (e.g., "2Gi", "512Mi")
      const match = cloudRunMemory.match(/^(\d+(?:\.\d+)?)([GM]i?)$/);
      if (match) {
        const value = parseFloat(match[1]);
        const unit = match[2];
        switch (unit) {
          case "Gi":
            return value * 1024 * 1024 * 1024;
          case "Mi":
            return value * 1024 * 1024;
          case "G":
            return value * 1000 * 1000 * 1000;
          case "M":
            return value * 1000 * 1000;
          default:
            return value;
        }
      }
    }

    // Try to read from cgroup (container memory limit)
    try {
      // For cgroup v1
      if (fs.existsSync("/sys/fs/cgroup/memory/memory.limit_in_bytes")) {
        const limitStr = fs
          .readFileSync("/sys/fs/cgroup/memory/memory.limit_in_bytes", "utf8")
          .trim();
        const limit = parseInt(limitStr);
        // Ignore unrealistic limits (like 9223372036854775807)
        if (limit > 0 && limit < Number.MAX_SAFE_INTEGER / 2) {
          return limit;
        }
      }
      // For cgroup v2
      if (fs.existsSync("/sys/fs/cgroup/memory.max")) {
        const limitStr = fs
          .readFileSync("/sys/fs/cgroup/memory.max", "utf8")
          .trim();
        if (limitStr !== "max") {
          const limit = parseInt(limitStr);
          if (limit > 0) return limit;
        }
      }
    } catch (error) {
      this.logger.debug({ error }, "Could not read container memory limit");
    }

    // Default for 2Gi Cloud Run instance
    return 2 * 1024 * 1024 * 1024;
  }

  private isProxyError(error: any): boolean {
    // Check if error is related to proxy/network issues
    return (
      error?.message?.includes("ECONNREFUSED") ||
      error?.message?.includes("ETIMEDOUT") ||
      error?.message?.includes("proxy")
    );
  }

  /**
   * Get pool metrics
   */
  getMetrics(): any {
    const connections = Array.from(this.connections.values());
    const wsMetrics = this.wsManager.getMetrics();
    const errorStats = this.errorHandler.getStats();
    const coordinatorStats = this.instanceCoordinator.getStats();

    // Get cache stats for memory leak analysis

    return {
      totalConnections: this.connections.size,
      activeConnections: connections.filter(
        (c) => c.state.connection === "open",
      ).length,
      pendingConnections: connections.filter(
        (c) => c.state.connection === "connecting",
      ).length,
      totalMessages: connections.reduce((sum, c) => sum + c.messageCount, 0),
      memoryUsage: this.getMemoryUsage(),
      uptime: process.uptime(),
      proxyMetrics: this.proxyManager.getMetrics(),
      webSocketHealth: {
        healthyConnections: wsMetrics.healthyConnections,
        degradedConnections: wsMetrics.degradedConnections,
        failedConnections: wsMetrics.failedConnections,
        averageFailures: wsMetrics.averageFailures,
      },
      errorHandling: {
        circuitBreakers: errorStats.circuitBreakers,
        errorStats: errorStats.errorStats,
        config: errorStats.config,
      },
      instanceCoordination: {
        instanceId: coordinatorStats.instanceId,
        ownedSessions: coordinatorStats.ownedSessions,
        totalInstances: coordinatorStats.totalInstances,
        healthyInstances: coordinatorStats.healthyInstances,
        instances: coordinatorStats.instances,
        config: coordinatorStats.config,
      },
    };
  }

  /**
   * Shutdown the pool
   * @param preserveSessions - If true, close connections without logging out (for deployments)
   */
  async shutdown(preserveSessions = true) {
    this.isShuttingDown = true;
    this.logger.info({ preserveSessions }, "Shutting down connection pool");

    // Clear timers
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    // Clear memory maps
    this.syncedContactInfo.clear();
    this.pendingChatMetadata.clear();
    this.importListRefs.clear();
    this.sentMessageIds.clear();

    // Close all connections
    if (preserveSessions) {
      this.logger.info(
        "Gracefully closing connections to preserve sessions for recovery",
      );
      for (const connection of this.connections.values()) {
        await this.removeConnection(
          connection.userId,
          connection.phoneNumber,
          true,
        ); // skipLogout = true
      }
    } else {
      this.logger.info("Fully logging out all connections");
      for (const connection of this.connections.values()) {
        await this.removeConnection(
          connection.userId,
          connection.phoneNumber,
          false,
        ); // skipLogout = false
      }
    }

    // Shutdown WebSocket manager
    this.wsManager.shutdown();

    // Shutdown error handler
    this.errorHandler.shutdown();

    // Shutdown instance coordinator
    await this.instanceCoordinator.shutdown();

    // Shutdown session manager (performs final backups in hybrid mode)
    await this.sessionManager.shutdown();

    this.logger.info("Connection pool shutdown complete");
  }

  /**
   * Update session state in users/{userId}/phone_numbers subcollection for recovery
   */
  private async updateSessionForRecovery(
    userId: string,
    phoneNumber: string,
    status: "connected" | "pending_recovery" | "failed",
    proxyCountry?: string,
  ): Promise<void> {
    try {
      const sessionRef = this.firestore
        .collection("users")
        .doc(userId)
        .collection("phone_numbers")
        .doc(phoneNumber);

      // Check if document already exists to preserve country_code
      const existingDoc = await sessionRef.get();

      // Don't recreate deleted documents - respect user/system deletions
      if (!existingDoc.exists) {
        this.logger.info(
          { userId, phoneNumber },
          "Phone number document doesn't exist (was deleted), skipping session recovery update to respect deletion",
        );
        return;
      }

      const existingData = existingDoc.data() || {};

      // Determine if instance is localhost
      const isLocalhost =
        this.config.instanceUrl.includes("localhost") ||
        this.config.instanceUrl.includes("127.0.0.1");

      // Build session data using NESTED FIELD UPDATES to preserve existing whatsapp_web fields
      // This prevents overwriting status and sync progress set by other functions
      const sessionData: any = {
        phone_number: phoneNumber,
        type: "whatsapp_web",
        updated_at: admin.firestore.Timestamp.now(),
        // Use nested field syntax to update only specific fields
        "whatsapp_web.last_activity": admin.firestore.Timestamp.now(),
        "whatsapp_web.last_updated": admin.firestore.Timestamp.now(),
        "whatsapp_web.instance_url": this.config.instanceUrl,
        "whatsapp_web.is_localhost": isLocalhost,
        "whatsapp_web.session_id": `${userId}-${phoneNumber}`,
        "whatsapp_web.session_exists": true, // Required by SessionRecoveryService
      };

      // Only update status field for actual recovery states
      // For "connected" recovery tracking, DON'T update status (let updatePhoneNumberStatus handle it)
      // This prevents overwriting "importing_messages" status set during initial sync
      if (status === "pending_recovery" || status === "failed") {
        sessionData["whatsapp_web.status"] = status;
        this.logger.debug(
          { userId, phoneNumber, status },
          "Updating status for recovery state",
        );
      } else {
        this.logger.debug(
          { userId, phoneNumber, status },
          "Skipping status update - preserving UI status set by updatePhoneNumberStatus",
        );
      }

      // Add proxy country if available
      if (proxyCountry) {
        sessionData["whatsapp_web.proxy_country"] = proxyCountry;
      }

      // Use phone's country from existing data (user-selected from frontend)
      const phoneCountry =
        existingData?.whatsapp_web?.phone_country || existingData?.country_code;

      if (phoneCountry) {
        sessionData["whatsapp_web.phone_country"] = phoneCountry;
      }

      // Preserve country_code at root level for backward compatibility
      if (existingData?.country_code) {
        sessionData.country_code = existingData.country_code;
        this.logger.debug(
          {
            userId,
            phoneNumber,
            existing_country: existingData.country_code,
            proxy_country: proxyCountry,
          },
          "Preserving existing country_code during session update",
        );
      } else if (phoneCountry) {
        sessionData.country_code = phoneCountry;
        this.logger.info(
          { userId, phoneNumber, country_code: phoneCountry },
          "Setting initial country_code for new session",
        );
      }

      await sessionRef.update(sessionData);

      this.logger.info(
        { userId, phoneNumber, status, proxyCountry },
        "Updated session for recovery in users subcollection",
      );
    } catch (error) {
      this.logger.error(
        { userId, phoneNumber, status, error },
        "Failed to update session for recovery",
      );
    }
  }

  /**
   * Remove session from recovery tracking
   * IMPORTANT: This should NOT delete the phone number document, only clear recovery metadata
   */
  private async removeSessionFromRecovery(
    userId: string,
    phoneNumber: string,
  ): Promise<void> {
    try {
      const sessionRef = this.firestore
        .collection("users")
        .doc(userId)
        .collection("phone_numbers")
        .doc(phoneNumber);

      // Check if document exists before updating
      const doc = await sessionRef.get();
      if (!doc.exists) {
        this.logger.info(
          { userId, phoneNumber },
          "Phone number document doesn't exist (was deleted), skipping recovery tracking removal",
        );
        return;
      }

      // Don't delete the document! Just clear recovery-specific fields
      await sessionRef.update({
        recovery_instance_url: null,
        recovery_status: null,
        recovery_proxy_country: null,
        updated_at: new Date(),
      });

      this.logger.info(
        { userId, phoneNumber },
        "Removed session from recovery tracking (phone number preserved)",
      );
    } catch (error) {
      this.logger.error(
        { userId, phoneNumber, error },
        "Failed to remove session from recovery tracking",
      );
    }
  }

  /**
   * Get active sessions from users/{userId}/phone_numbers subcollection using collection group
   */
  async getActiveSessionsForRecovery(): Promise<
    Array<{
      userId: string;
      phoneNumber: string;
      proxyCountry?: string;
      lastActivity: Date;
    }>
  > {
    try {
      const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours

      // Use collection group to query across all users' phone_numbers subcollections
      const activeSessionsSnapshot = await this.firestore
        .collectionGroup("phone_numbers")
        .where("type", "==", "whatsapp_web")
        .where("whatsapp_web.status", "in", ["connected", "pending_recovery"])
        .where(
          "whatsapp_web.last_activity",
          ">=",
          admin.firestore.Timestamp.fromDate(cutoffTime),
        )
        .get();

      const sessions: Array<{
        userId: string;
        phoneNumber: string;
        proxyCountry?: string;
        lastActivity: Date;
      }> = [];
      activeSessionsSnapshot.forEach((doc) => {
        const data = doc.data();
        // Extract userId from parent document path: users/{userId}/phone_numbers/{phoneNumber}
        const userId = doc.ref.parent.parent?.id;
        if (userId) {
          sessions.push({
            userId,
            phoneNumber: data.phone_number,
            proxyCountry: data.proxy_country || data.country_code,
            lastActivity:
              data.whatsapp_web?.last_activity?.toDate() || new Date(),
          });
        }
      });

      this.logger.info(
        { count: sessions.length },
        "Retrieved active sessions for recovery",
      );

      return sessions;
    } catch (error) {
      this.logger.error(
        { error },
        "Failed to get active sessions for recovery",
      );
      return [];
    }
  }
}
