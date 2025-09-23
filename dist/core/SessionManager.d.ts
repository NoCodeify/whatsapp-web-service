import { WASocket, AuthenticationState } from "@whiskeysockets/baileys";
import { ProxyManager } from "./ProxyManager";
import { Firestore } from "@google-cloud/firestore";
export interface SessionData {
  userId: string;
  phoneNumber: string;
  authState: AuthenticationState;
  createdAt: Date;
  lastUsed: Date;
}
export declare class SessionManager {
  private logger;
  private proxyManager;
  private firestore;
  private storage?;
  private sessionsDir;
  private sessions;
  private readonly encryptionKey;
  private readonly bucketName;
  private readonly storageType;
  private readonly backupInterval;
  private backupTimers;
  constructor(proxyManager: ProxyManager, firestore: Firestore);
  /**
   * Initialize sessions directory
   */
  private initializeSessionsDirectory;
  /**
   * Create a new WhatsApp connection with Baileys
   */
  createConnection(
    userId: string,
    phoneNumber: string,
    proxyCountry?: string,
    browserName?: string,
  ): Promise<WASocket>;
  /**
   * Get or create authentication state
   */
  private getAuthState;
  /**
   * Check if local session files exist
   */
  private localSessionExists;
  /**
   * Setup automatic backup for hybrid mode
   */
  private setupAutoBackup;
  /**
   * Save authentication state to Cloud Storage
   */
  private saveAuthState;
  /**
   * Backup session to Cloud Storage
   */
  private backupToCloudStorage;
  /**
   * Restore session from Cloud Storage
   */
  private restoreFromCloudStorage;
  /**
   * Get message from database (for message retries)
   */
  private getMessage;
  /**
   * Encrypt data
   */
  private encrypt;
  /**
   * Decrypt data
   */
  private decrypt;
  /**
   * Delete a session
   */
  deleteSession(userId: string, phoneNumber: string): Promise<void>;
  /**
   * Check if session exists
   */
  sessionExists(userId: string, phoneNumber: string): Promise<boolean>;
  /**
   * List all sessions from the filesystem
   */
  listAllSessions(): Promise<
    Array<{
      userId: string;
      phoneNumber: string;
    }>
  >;
  /**
   * Get session metrics
   */
  getMetrics(): {
    totalSessions: number;
    averageSessionAge: number;
    oldestSession: SessionData | null;
  };
  /**
   * Cleanup old sessions
   */
  cleanupSessions(maxAge?: number): Promise<number>;
  /**
   * Helper method to get session key
   */
  private getSessionKey;
  /**
   * Shutdown the session manager and cleanup resources
   */
  shutdown(): Promise<void>;
}
//# sourceMappingURL=SessionManager.d.ts.map
