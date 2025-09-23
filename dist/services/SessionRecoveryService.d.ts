import { Firestore } from "@google-cloud/firestore";
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
export declare class SessionRecoveryService {
  private logger;
  private firestore;
  private dynamicProxyService;
  private connectionPool?;
  private isRecovering;
  private instanceId;
  private readonly options;
  constructor(
    firestore: Firestore,
    dynamicProxyService: DynamicProxyService,
    instanceId?: string,
  );
  /**
   * Set the connection pool reference
   */
  setConnectionPool(connectionPool: ConnectionPool): void;
  /**
   * Mark this instance as started in Firestore
   */
  private markInstanceStartup;
  /**
   * Recover all active sessions after server restart
   */
  recoverActiveSessions(): Promise<void>;
  /**
   * Get active sessions that need recovery
   */
  private getActiveSessionsToRecover;
  /**
   * Prioritize sessions by country
   */
  private prioritizeSessions;
  /**
   * Recover a single session
   */
  private recoverSession;
  /**
   * Reactivate an existing proxy (no longer supported - always purchase new)
   */
  private reactivateProxy;
  /**
   * Update session recovery status
   */
  private updateSessionStatus;
  /**
   * Detect country from phone number
   */
  private detectCountryFromPhone;
  /**
   * Graceful shutdown - mark sessions appropriately
   */
  shutdown(): Promise<void>;
  /**
   * Cleanup old server instances
   */
  cleanupOldInstances(): Promise<void>;
  /**
   * Helper to delay execution
   */
  private delay;
}
//# sourceMappingURL=SessionRecoveryService.d.ts.map
