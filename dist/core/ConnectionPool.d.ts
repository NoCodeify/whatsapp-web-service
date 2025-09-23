import {
  WASocket,
  ConnectionState,
  WAMessageContent,
  WAMessageKey,
} from "@whiskeysockets/baileys";
import { EventEmitter } from "events";
import { ProxyManager } from "./ProxyManager";
import { SessionManager } from "./SessionManager";
import { Firestore } from "@google-cloud/firestore";
import { PubSub } from "@google-cloud/pubsub";
import { ConnectionStateManager } from "../services/connectionStateManager";
import { MediaService } from "../services/MediaService";
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
export declare class ConnectionPool extends EventEmitter {
  private connections;
  private logger;
  private proxyManager;
  private sessionManager;
  private firestore;
  private pubsub;
  private connectionStateManager?;
  private mediaService;
  private healthCheckTimer?;
  private cleanupTimer?;
  private importListRefs;
  private pendingChatMetadata;
  private syncedContactInfo;
  private sentMessageIds;
  private processedContactsCache;
  private readonly config;
  constructor(
    proxyManager: ProxyManager,
    sessionManager: SessionManager,
    firestore: Firestore,
    pubsub: PubSub,
    connectionStateManager?: ConnectionStateManager,
  );
  /**
   * Initialize recovery of previous connections after server restart
   */
  initializeRecovery(): Promise<void>;
  /**
   * Add a new WhatsApp connection to the pool
   */
  addConnection(
    userId: string,
    phoneNumber: string,
    proxyCountry?: string,
    countryCode?: string,
    isRecovery?: boolean,
    browserName?: string,
  ): Promise<boolean>;
  /**
   * Remove a connection from the pool
   */
  removeConnection(userId: string, phoneNumber: string): Promise<void>;
  /**
   * Get a connection from the pool
   */
  getConnection(userId: string, phoneNumber: string): WhatsAppConnection | null;
  /**
   * Get the media service instance
   */
  getMediaService(): MediaService;
  /**
   * Send a message using a connection from the pool
   */
  sendMessage(
    userId: string,
    phoneNumber: string,
    toNumber: string,
    content: WAMessageContent,
  ): Promise<WAMessageKey | null>;
  /**
   * Setup event handlers for a connection
   */
  private setupConnectionHandlers;
  /**
   * Handle QR code generation
   */
  private handleQRCode;
  /**
   * Handle incoming messages
   */
  private handleIncomingMessage;
  /**
   * Handle outgoing messages (both API-sent and manual from phone)
   */
  private handleOutgoingMessage;
  /**
   * Handle message status updates
   */
  private handleMessageUpdate;
  /**
   * Handle presence updates
   */
  private handlePresenceUpdate;
  /**
   * Handle typing indicators
   */
  private handleTypingIndicator;
  /**
   * Create or find existing import list for WhatsApp Web contacts
   */
  private createImportList;
  /**
   * Extract message text with better media type labels
   */
  private extractMessageText;
  /**
   * Handle media message - download and upload to Cloud Storage
   */
  private handleMediaMessage;
  /**
   * Check if messages represent a real conversation
   */
  private isRealConversation;
  /**
   * Extract first and last name from a full name string
   * Handles titles like Dr., Mr., Mrs., etc. and multi-word names
   */
  private extractNames;
  /**
   * Process synced contacts from history
   */
  private processSyncedContacts;
  /**
   * Process synced chats from history
   */
  private processSyncedChats;
  /**
   * Process synced messages from history
   */
  private processSyncedMessages;
  /**
   * Reconnect a connection
   */
  private reconnect;
  /**
   * Handle proxy errors
   */
  private handleProxyError;
  /**
   * Create or update phone number record
   */
  private createPhoneNumberRecord;
  /**
   * Update connection status in Firestore
   */
  private updateConnectionStatus;
  /**
   * Publish events to Pub/Sub
   */
  private publishEvent;
  /**
   * Health check for connections
   */
  private startHealthCheck;
  /**
   * Cleanup old sessions
   */
  private startCleanup;
  /**
   * Helper methods
   */
  private getConnectionKey;
  private formatJid;
  private hasCapacity;
  private hasMemory;
  private getMemoryUsage;
  private isProxyError;
  /**
   * Get pool metrics
   */
  getMetrics(): {
    totalConnections: number;
    activeConnections: number;
    pendingConnections: number;
    totalMessages: number;
    memoryUsage: number;
    uptime: number;
    proxyMetrics: Promise<{
      ispProxy?:
        | {
            total: number;
            assigned: number;
            available: number;
            assignments: number;
            utilizationRate: number;
          }
        | undefined;
      dynamicProxy?:
        | {
            message: string;
          }
        | undefined;
      activeSessions: number;
      totalRotations: number;
      avgRotationsPerSession: number;
      oldestSessionAge: number;
      proxyType: string;
    }>;
  };
  /**
   * Shutdown the pool
   */
  shutdown(): Promise<void>;
}
//# sourceMappingURL=ConnectionPool.d.ts.map
