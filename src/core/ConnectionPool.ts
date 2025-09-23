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
import { ProxyManager } from "./ProxyManager";
import { SessionManager } from "./SessionManager";
import { Firestore } from "@google-cloud/firestore";
import { PubSub } from "@google-cloud/pubsub";
import { ConnectionStateManager } from "../services/connectionStateManager";
import { MediaService } from "../services/MediaService";
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
  createdAt: Date;
  lastActivity: Date;
  messageCount: number;
  proxySessionId?: string;
  instanceUrl: string;
}

export interface ConnectionPoolConfig {
  maxConnections: number;
  memoryThreshold: number;
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
  private healthCheckTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
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
    memoryThreshold: parseFloat(process.env.MEMORY_THRESHOLD || "0.8"),
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
  ) {
    super();
    this.proxyManager = proxyManager;
    this.sessionManager = sessionManager;
    this.firestore = firestore;
    this.pubsub = pubsub;
    this.connectionStateManager = connectionStateManager;
    this.mediaService = new MediaService();

    this.startHealthCheck();
    this.startCleanup();
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
          // Attempt recovery using session files
          const success = await this.addConnection(
            userId,
            phoneNumber,
            undefined, // No proxy country for recovery
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

    // Check memory usage
    if (!this.hasMemory()) {
      const memoryPercentage = (this.getMemoryUsage() * 100).toFixed(1);
      this.logger.warn(
        {
          memoryUsage: `${memoryPercentage}%`,
          threshold: `${(this.config.memoryThreshold * 100).toFixed(0)}%`,
          connections: this.connections.size,
        },
        "Memory threshold exceeded",
      );
      this.emit("memory-threshold-exceeded");
      return false;
    }

    try {
      // Initialize connection state if manager is available
      if (this.connectionStateManager) {
        if (isRecovery) {
          // Update existing state for recovery
          await this.connectionStateManager.updateState(userId, phoneNumber, {
            status: "connecting",
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

      // Create or update phone number record
      await this.createPhoneNumberRecord(
        userId,
        phoneNumber,
        countryCode || proxyCountry,
      );

      // Create connection with proxy and custom browser name
      const socket = await this.sessionManager.createConnection(
        userId,
        phoneNumber,
        proxyCountry,
        browserName,
      );

      const connection: WhatsAppConnection = {
        userId,
        phoneNumber,
        socket,
        state: { connection: "connecting" } as ConnectionState,
        createdAt: new Date(),
        lastActivity: new Date(),
        messageCount: 0,
        instanceUrl: this.config.instanceUrl,
        proxySessionId: proxyCountry,
      };

      // Set up event handlers
      this.setupConnectionHandlers(connection);

      // Add to pool
      this.connections.set(connectionKey, connection);

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
   */
  async removeConnection(userId: string, phoneNumber: string): Promise<void> {
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

    try {
      // Clear QR timeout if exists
      if (connection.qrTimeout) {
        clearTimeout(connection.qrTimeout);
        connection.qrTimeout = undefined;
      }

      // Properly logout from WhatsApp first, then end connection
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

      // Close the socket
      connection.socket.end(undefined);

      // Remove from pool
      this.connections.delete(connectionKey);

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

      // Update Firestore
      await this.updateConnectionStatus(userId, phoneNumber, "disconnected");

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

    // Track if sync has been completed to avoid duplicate events
    let syncCompleted = false;

    // Track cumulative sync counts for this connection
    let totalContactsSynced = 0;
    let totalMessagesSynced = 0;

    // Connection updates
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
      if (state === "connecting") {
        this.emit("connection-update", {
          userId,
          phoneNumber,
          status: "connecting",
        });
      }

      if (qr) {
        this.logger.info(
          { userId, phoneNumber, qrLength: qr.length },
          "QR code received from Baileys",
        );
        connection.qrCode = qr;
        await this.handleQRCode(userId, phoneNumber, qr);

        // Set QR expiration timeout to prevent orphaned proxies
        connection.qrTimeout = setTimeout(async () => {
          if (connection.state.connection !== "open") {
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

        // Clear QR timeout since connection is now established
        if (connection.qrTimeout) {
          clearTimeout(connection.qrTimeout);
          connection.qrTimeout = undefined;
        }

        // Update connection state manager if available
        if (this.connectionStateManager) {
          await this.connectionStateManager.markConnected(userId, phoneNumber);
        }

        await this.updateConnectionStatus(userId, phoneNumber, "connected");

        // Emit connection established event
        this.emit("connection-update", {
          userId,
          phoneNumber,
          status: "connected",
        });

        this.logger.info(
          { userId, phoneNumber },
          "WhatsApp connection established",
        );

        // Emit sync started event with small delay to ensure WebSocket clients are ready
        setTimeout(() => {
          this.logger.info(
            { userId, phoneNumber },
            "Emitting sync:started event",
          );
          this.emit("sync:started", {
            userId,
            phoneNumber,
            timestamp: new Date().toISOString(),
          });
        }, 100);

        // Set a longer timeout for sync completion
        // Give more time for messages to sync in background
        setTimeout(() => {
          // Only emit if sync hasn't completed yet
          if (!syncCompleted) {
            syncCompleted = true;
            this.logger.info(
              { userId, phoneNumber },
              "Sync timeout reached, completing sync",
            );

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
            { userId, phoneNumber, disconnectReason },
            "Connection replaced - session is active elsewhere, not reconnecting",
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

        if (shouldReconnect) {
          this.logger.info(
            { userId, phoneNumber, disconnectReason },
            "Connection closed, attempting reconnect",
          );
          await this.reconnect(userId, phoneNumber);
        } else {
          await this.removeConnection(userId, phoneNumber);
        }
      }
    });

    // Message handling - process BOTH incoming and outgoing
    socket.ev.on("messages.upsert", async (upsert) => {
      for (const msg of upsert.messages) {
        if (!msg.message) continue; // Skip empty messages

        if (!msg.key.fromMe) {
          // Incoming message from contact
          await this.handleIncomingMessage(userId, phoneNumber, msg);
        } else {
          // Outgoing message - could be manual or API-sent
          await this.handleOutgoingMessage(userId, phoneNumber, msg);
        }
      }
      connection.lastActivity = new Date();
    });

    // Message status updates
    socket.ev.on("messages.update", async (updates) => {
      for (const update of updates) {
        await this.handleMessageUpdate(userId, phoneNumber, update);
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

          this.logger.info(
            {
              userId,
              phoneNumber,
              totalContacts: totalContactsSynced,
              totalMessages: totalMessagesSynced,
            },
            "Latest history batch received, completing sync",
          );

          // Emit sync completion event with cumulative totals
          this.emit("history-synced", {
            userId,
            phoneNumber,
            contacts: totalContactsSynced,
            messages: totalMessagesSynced,
          });
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

    // Handle messages.upsert to catch history messages
    socket.ev.on("messages.upsert", async (upsert) => {
      // Check if these are history messages (not real-time)
      if (upsert.type === "append" || upsert.type === "notify") {
        this.logger.info(
          {
            userId,
            phoneNumber,
            type: upsert.type,
            count: upsert.messages?.length || 0,
            requestId: upsert.requestId,
            firstMessage: upsert.messages?.[0]
              ? {
                  id: upsert.messages[0].key?.id,
                  remoteJid: upsert.messages[0].key?.remoteJid,
                  timestamp: upsert.messages[0].messageTimestamp,
                }
              : null,
          },
          "Messages upsert event - checking for history",
        );

        // Process as history messages if they're old (more than 1 hour old)
        const oldMessages = upsert.messages.filter((msg: any) => {
          const msgTime = (msg.messageTimestamp || 0) * 1000;
          const hourAgo = Date.now() - 60 * 60 * 1000;
          return msgTime < hourAgo;
        });

        if (oldMessages.length > 0) {
          this.logger.info(
            {
              userId,
              phoneNumber,
              count: oldMessages.length,
            },
            "Processing old messages from upsert as history",
          );

          const count = await this.processSyncedMessages(
            userId,
            phoneNumber,
            oldMessages,
          );
          totalMessagesSynced += count;

          // Emit progress event
          this.emit("sync:progress", {
            userId,
            phoneNumber,
            type: "messages_from_upsert",
            count: oldMessages.length,
            timestamp: new Date().toISOString(),
          });
        }
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

      // Store QR code in Firestore (async, don't block)
      const sessionRef = this.firestore
        .collection("users")
        .doc(userId)
        .collection("whatsapp_web_sessions")
        .doc(phoneNumber);

      sessionRef
        .set(
          {
            qr_code: qr,
            status: "qr_pending",
            instance_url: this.config.instanceUrl,
            updated_at: new Date(),
          },
          { merge: true },
        )
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

      // Extract message text early for logging
      const messageText = this.extractMessageText(message);

      // Log incoming message with full details
      this.logger.info(
        {
          userId,
          phoneNumber: phoneNumber,
          fromNumber: fromNumber,
          fromJid,
          messageId: message.key.id,
          body: messageText,
          isGroup,
          pushName: message.pushName,
          timestamp: message.messageTimestamp,
        },
        "Incoming WhatsApp message received",
      );

      // Skip group messages for now
      if (isGroup) {
        this.logger.debug(
          { userId, phoneNumber, fromJid },
          "Skipping group message",
        );
        return;
      }

      // Format phone numbers with + prefix
      const formattedFromPhone = fromNumber.startsWith("+")
        ? fromNumber
        : `+${fromNumber}`;
      const formattedUserPhone = phoneNumber.startsWith("+")
        ? phoneNumber
        : `+${phoneNumber}`;

      // Get or create contact in root collection
      const userRef = this.firestore.collection("users").doc(userId);
      const currentTimestamp = admin.firestore.Timestamp.now();

      const existingContacts = await this.firestore
        .collection("contacts")
        .where("user", "==", userRef)
        .where("phone_number", "==", formattedFromPhone)
        .limit(1)
        .get();

      let contactRef;
      if (existingContacts.empty) {
        // Extract first and last name from WhatsApp push name
        const { firstName, lastName } = this.extractNames(message.pushName);

        // Create new contact in root collection
        // IMPORTANT: WhatsApp Web imported contacts are intentionally created WITHOUT campaigns
        // These are manual conversation contacts that should not trigger bot interactions or analytics
        const newContactData = {
          created_at: currentTimestamp,
          email: "",
          first_name: firstName || "Unknown",
          last_name: lastName || "Unknown",
          phone_number: formattedFromPhone,
          user: userRef,
          last_modified_at: currentTimestamp,
          last_activity_at: currentTimestamp,
          last_incoming_message_at: currentTimestamp,
          whatsapp_name: message.pushName || null,
          channel: "whatsapp_web",
          is_bot_active: false,
          has_had_activity: true,
          bot_message_count: 0,
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
          // Note: current_campaign is intentionally not set - these contacts are for manual conversations
          credits_used: 0,
          last_updated_by: "whatsapp_web_incoming",
          lists: [],
          campaigns: [],
          tags: [],
        };

        const newContactRef = await this.firestore
          .collection("contacts")
          .add(newContactData);
        contactRef = newContactRef;

        this.logger.info(
          { userId, phoneNumber, fromNumber: formattedFromPhone },
          "Created new contact from incoming message",
        );
      } else {
        // Update existing contact
        contactRef = existingContacts.docs[0].ref;
        await contactRef.update({
          last_activity_at: currentTimestamp,
          last_incoming_message_at: currentTimestamp,
          last_modified_at: currentTimestamp,
          has_had_activity: true,
          whatsapp_name:
            message.pushName ||
            existingContacts.docs[0].data().whatsapp_name ||
            null,
        });
      }

      // Store message as subcollection of contact
      // messageText already extracted at the beginning for logging

      // Handle media if present
      const mediaInfo = await this.handleMediaMessage(
        message,
        userId,
        phoneNumber,
      );

      const messageData = {
        // Core message fields
        message_sid: message.key.id,
        from_phone_number: formattedFromPhone,
        to_phone_number: formattedUserPhone,
        body: messageText,
        direction: "inbound",
        status: "received",
        channel: "whatsapp_web",
        timestamp: admin.firestore.Timestamp.fromMillis(
          message.messageTimestamp * 1000,
        ),
        created_at: currentTimestamp,

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

      // Add message to contact's messages subcollection
      await contactRef.collection("messages").add(messageData);

      this.logger.info(
        {
          userId,
          phoneNumber,
          messageId: message.key.id,
          fromNumber,
        },
        "Incoming message stored in Firestore",
      );

      // Emit event for real-time updates
      this.emit("message-stored", {
        userId,
        phoneNumber,
        messageId: message.key.id,
        fromNumber,
        timestamp: new Date().toISOString(),
      });

      // For production, also publish to Pub/Sub for additional processing
      if (
        process.env.NODE_ENV !== "development" &&
        !process.env.FIRESTORE_EMULATOR_HOST
      ) {
        const topic = this.pubsub.topic("whatsapp-web-incoming");
        await topic.publishMessage({
          data: Buffer.from(
            JSON.stringify({
              userId,
              phoneNumber,
              message,
              timestamp: new Date().toISOString(),
            }),
          ),
        });
      }
    } catch (error) {
      this.logger.error(
        { userId, phoneNumber, error },
        "Failed to handle incoming message",
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
          email: "",
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
    if (message.message?.imageMessage) {
      return message.message.imageMessage.caption || "[Image]";
    }
    if (message.message?.videoMessage) {
      return message.message.videoMessage.caption || "[Video]";
    }
    if (message.message?.audioMessage) {
      return "[Audio]";
    }
    if (message.message?.documentMessage) {
      const fileName = message.message.documentMessage.fileName || "";
      return fileName ? `[Document: ${fileName}]` : "[Document]";
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
        }
      }

      this.logger.info(
        { userId, phoneNumber, totalSynced: syncedCount },
        "Contacts sync completed",
      );

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
            email: "",
            first_name: firstName && firstName !== "" ? firstName : "Unknown",
            last_name: lastName && lastName !== "" ? lastName : "Unknown",
            phone_number: formattedContactPhone,
            user: userRef,
            last_modified_at: currentTimestamp,
            channel: "whatsapp_web",
            is_bot_active: false,
            has_had_activity: true,
            bot_message_count: 0,
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

        // Process all messages for this contact
        let messagesAddedForContact = 0;
        for (const msg of contactMessages) {
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

          // Add message to contact's messages subcollection
          const messageDocRef = await contactRef
            .collection("messages")
            .add(messageData);

          // Track the last message for this contact
          if (
            !lastMessageData ||
            msg.messageTimestamp > lastMessageData.messageTimestamp
          ) {
            lastMessageData = msg;
            lastMessageRef = messageDocRef;
          }

          messagesAddedForContact++;
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
      // Try to reconnect
      const success = await this.addConnection(userId, phoneNumber);
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
   * Create or update phone number record
   */
  private async createPhoneNumberRecord(
    userId: string,
    phoneNumber: string,
    countryCode?: string,
  ) {
    try {
      const phoneNumberRef = this.firestore
        .collection("users")
        .doc(userId)
        .collection("phone_numbers")
        .doc(phoneNumber);

      const phoneDoc = await phoneNumberRef.get();

      if (!phoneDoc.exists) {
        // Create new phone number record for WhatsApp Web
        await phoneNumberRef.set({
          phone_number: phoneNumber,
          country_code: countryCode || "",
          is_active: true,
          purchase_date: new Date(),
          type: "whatsapp_web",
          whatsapp_web_status: "initializing",
          messaging_limit: 25, // Default limit for WhatsApp Web
          messages_sent: 0,
          credits_used: 0,
          created_at: new Date(),
          updated_at: new Date(),
        });

        this.logger.info(
          { userId, phoneNumber, countryCode },
          "Created phone number record for WhatsApp Web",
        );
      } else {
        // Update existing record
        await phoneNumberRef.update({
          whatsapp_web_status: "initializing",
          country_code: countryCode || phoneDoc.data()?.country_code || "",
          updated_at: new Date(),
        });

        this.logger.info(
          { userId, phoneNumber },
          "Updated existing phone number record",
        );
      }
    } catch (error) {
      this.logger.error(
        { userId, phoneNumber, error },
        "Failed to create/update phone number record",
      );
      // Don't throw - allow connection to proceed even if record creation fails
    }
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
        .collection("whatsapp_web_sessions")
        .doc(phoneNumber);

      await sessionRef.set(
        {
          status,
          instance_url: this.config.instanceUrl,
          updated_at: new Date(),
        },
        { merge: true },
      );
    } catch (error) {
      this.logger.error(
        { userId, phoneNumber, error },
        "Failed to update connection status",
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

        // Remove connections idle for more than 1 hour
        if (idleTime > 3600000) {
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

  private hasCapacity(): boolean {
    return this.connections.size < this.config.maxConnections;
  }

  private hasMemory(): boolean {
    // Skip memory check if disabled for local development
    if (
      process.env.DISABLE_MEMORY_CHECK === "true" ||
      process.env.NODE_ENV === "development"
    ) {
      return true;
    }
    return this.getMemoryUsage() < this.config.memoryThreshold;
  }

  private getMemoryUsage(): number {
    const used = process.memoryUsage().heapUsed;
    const total = process.memoryUsage().heapTotal;
    return used / total;
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
  getMetrics() {
    const connections = Array.from(this.connections.values());

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
    };
  }

  /**
   * Shutdown the pool
   */
  async shutdown() {
    this.logger.info("Shutting down connection pool");

    // Clear timers
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);

    // Clear memory maps
    this.syncedContactInfo.clear();
    this.pendingChatMetadata.clear();
    this.importListRefs.clear();
    this.sentMessageIds.clear();

    // Close all connections
    for (const connection of this.connections.values()) {
      await this.removeConnection(connection.userId, connection.phoneNumber);
    }

    // Shutdown session manager (performs final backups in hybrid mode)
    await this.sessionManager.shutdown();

    this.logger.info("Connection pool shutdown complete");
  }
}
