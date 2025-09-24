import { EventEmitter } from "events";
import { Firestore } from "@google-cloud/firestore";
import { ConnectionPool } from "../core/ConnectionPool";
import { ConnectionStateManager } from "./connectionStateManager";
export interface HealthStatus {
    status: "healthy" | "degraded" | "unhealthy";
    timestamp: Date;
    uptime: number;
    connections: {
        total: number;
        active: number;
        failed: number;
        recovering: number;
    };
    resources: {
        cpu: number;
        memory: {
            used: number;
            total: number;
            percentage: number;
        };
        disk?: {
            used: number;
            total: number;
            percentage: number;
        };
    };
    queue: {
        waiting: number;
        active: number;
        failed: number;
        delayed: number;
    };
    errors: {
        count: number;
        recent: string[];
    };
    lastCheck: Date;
    nextCheck: Date;
}
export interface RecoveryAction {
    type: "restart_connection" | "clear_queue" | "rotate_proxy" | "alert_admin";
    target?: string;
    reason: string;
    timestamp: Date;
    success?: boolean;
    error?: string;
}
export declare class HealthMonitor extends EventEmitter {
    private logger;
    private firestore;
    private connectionPool?;
    private stateManager?;
    private status;
    private recentErrors;
    private checkInterval;
    private recoveryInProgress;
    private readonly config;
    constructor(firestore: Firestore);
    /**
     * Set service dependencies
     */
    setDependencies(connectionPool: ConnectionPool, stateManager: ConnectionStateManager): void;
    /**
     * Initialize health status
     */
    private initializeStatus;
    /**
     * Start health monitoring
     */
    private startMonitoring;
    /**
     * Perform health check
     */
    private performHealthCheck;
    /**
     * Update system metrics
     */
    private updateSystemMetrics;
    /**
     * Update service metrics
     */
    private updateServiceMetrics;
    /**
     * Evaluate overall health status
     */
    private evaluateHealth;
    /**
     * Perform recovery actions
     */
    private performRecovery;
    /**
     * Setup error handlers
     */
    private setupErrorHandlers;
    /**
     * Setup service listeners
     */
    private setupServiceListeners;
    /**
     * Record error
     */
    private recordError;
    /**
     * Trigger alert
     */
    private triggerAlert;
    /**
     * Log recovery actions
     */
    private logRecoveryActions;
    /**
     * Persist health status
     */
    private persistStatus;
    /**
     * Get current health status
     */
    getStatus(): HealthStatus;
    /**
     * Force health check
     */
    forceCheck(): Promise<HealthStatus>;
    /**
     * Shutdown health monitor
     */
    shutdown(): Promise<void>;
}
//# sourceMappingURL=healthMonitor.d.ts.map