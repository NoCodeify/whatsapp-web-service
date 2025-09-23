import { Firestore } from "@google-cloud/firestore";
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
export declare class ConnectionStateManager extends EventEmitter {
  private firestore;
  private logger;
  private states;
  private heartbeatTimers;
  private readonly HEARTBEAT_INTERVAL;
  constructor(firestore: Firestore);
  /**
   * Initialize connection state
   */
  initializeState(
    userId: string,
    phoneNumber: string,
    instanceUrl: string,
  ): Promise<ConnectionState>;
  /**
   * Update connection state
   */
  updateState(
    userId: string,
    phoneNumber: string,
    updates: Partial<ConnectionState>,
  ): Promise<ConnectionState | null>;
  /**
   * Get connection state
   */
  getState(
    userId: string,
    phoneNumber: string,
  ): Promise<ConnectionState | null>;
  /**
   * Get all active connections
   */
  getActiveConnections(): Promise<ConnectionState[]>;
  /**
   * Recover connections after restart
   */
  recoverConnections(): Promise<ConnectionState[]>;
  /**
   * Mark connection as connected
   */
  markConnected(userId: string, phoneNumber: string): Promise<void>;
  /**
   * Mark connection as disconnected
   */
  markDisconnected(
    userId: string,
    phoneNumber: string,
    reason?: string,
  ): Promise<void>;
  /**
   * Mark connection as failed
   */
  markFailed(userId: string, phoneNumber: string, error: string): Promise<void>;
  /**
   * Update sync progress
   */
  updateSyncProgress(
    userId: string,
    phoneNumber: string,
    contacts: number,
    messages: number,
    completed?: boolean,
  ): Promise<void>;
  /**
   * Start heartbeat for connection
   */
  private startHeartbeat;
  /**
   * Stop heartbeat for connection
   */
  private stopHeartbeat;
  /**
   * Persist state to Firestore
   */
  private persistState;
  /**
   * Persist heartbeat only
   */
  private persistHeartbeat;
  /**
   * Load state from Firestore
   */
  private loadState;
  /**
   * Start cleanup task
   */
  private startCleanupTask;
  /**
   * Get state key
   */
  private getStateKey;
  /**
   * Get connection metrics
   */
  getMetrics(): Promise<{
    total: number;
    connected: number;
    connecting: number;
    disconnected: number;
    failed: number;
    qrPending: number;
    synced: number;
    totalMessages: number;
  }>;
  /**
   * Shutdown manager
   */
  shutdown(): Promise<void>;
}
//# sourceMappingURL=connectionStateManager.d.ts.map
