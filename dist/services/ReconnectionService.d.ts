import { SessionManager } from "../core/SessionManager";
import { ConnectionPool } from "../core/ConnectionPool";
import { Firestore } from "@google-cloud/firestore";
export interface ReconnectionAttempt {
    userId: string;
    phoneNumber: string;
    timestamp: Date;
}
export interface ReconnectionResult {
    success: boolean;
    status: "connected" | "needs_qr" | "failed" | "rate_limited" | "session_not_found";
    qrCode?: string;
    qrExpiresAt?: Date;
    proxy?: {
        ip?: string;
        country?: string;
        type?: string;
    };
    message?: string;
    retryAfter?: number;
}
export interface CanReconnectResult {
    canReconnect: boolean;
    reason?: string;
    sessionExists: boolean;
    rateLimited: boolean;
    retryAfter?: number;
}
export declare class ReconnectionService {
    private sessionManager;
    private connectionPool;
    private firestore;
    private recentAttempts;
    private readonly MAX_ATTEMPTS_PER_HOUR;
    private readonly RATE_LIMIT_WINDOW_MS;
    constructor(sessionManager: SessionManager, connectionPool: ConnectionPool, firestore: Firestore);
    /**
     * Check if a user can reconnect to their session
     */
    canReconnect(userId: string, phoneNumber: string): Promise<CanReconnectResult>;
    /**
     * Attempt to reconnect a user to their WhatsApp Web session
     */
    reconnect(userId: string, phoneNumber: string, forceNew?: boolean): Promise<ReconnectionResult>;
    /**
     * Generate a secure reconnection token for a user
     */
    generateReconnectionToken(userId: string, phoneNumber: string): string;
    /**
     * Validate a reconnection token
     */
    validateReconnectionToken(token: string): {
        userId: string;
        phoneNumber: string;
    } | null;
    /**
     * Get user's country from Firestore
     */
    private getUserCountry;
    /**
     * Check if user is rate limited
     */
    private checkRateLimit;
    /**
     * Record a reconnection attempt
     */
    private recordAttempt;
    /**
     * Clean up old reconnection attempts
     */
    private cleanupOldAttempts;
    /**
     * Get reconnection statistics for monitoring
     */
    getStats(): {
        totalAttempts: number;
        uniqueUsers: number;
        rateLimitedUsers: number;
    };
}
//# sourceMappingURL=ReconnectionService.d.ts.map