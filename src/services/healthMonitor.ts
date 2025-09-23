import { EventEmitter } from "events";
import pino from "pino";
import { Firestore } from "@google-cloud/firestore";
import * as admin from "firebase-admin";
import os from "os";
import { ConnectionPool } from "../core/ConnectionPool";
import { ConnectionStateManager } from "./connectionStateManager";
// import { MessageQueueService } from "./messageQueue"; // TODO: Implement message queue service

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

export class HealthMonitor extends EventEmitter {
  private logger = pino({ name: "HealthMonitor" });
  private firestore: Firestore;
  private connectionPool?: ConnectionPool;
  private stateManager?: ConnectionStateManager;
  // private messageQueue?: MessageQueueService; // TODO: Implement message queue service

  private status: HealthStatus;
  private recentErrors: string[] = [];
  private checkInterval: NodeJS.Timeout | null = null;
  private recoveryInProgress: Set<string> = new Set();

  private readonly config = {
    checkInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL || "30000"),
    maxErrors: parseInt(process.env.MAX_ERRORS_THRESHOLD || "10"),
    cpuThreshold: parseFloat(process.env.CPU_THRESHOLD || "80"),
    memoryThreshold: parseFloat(process.env.MEMORY_THRESHOLD || "85"),
    autoRecovery: process.env.AUTO_RECOVERY !== "false",
    alertThreshold: parseInt(process.env.ALERT_THRESHOLD || "5"),
  };

  constructor(firestore: Firestore) {
    super();
    this.firestore = firestore;

    this.status = this.initializeStatus();
    this.setupErrorHandlers();
    this.startMonitoring();

    this.logger.info(this.config, "Health monitor initialized");
  }

  /**
   * Set service dependencies
   */
  setDependencies(
    connectionPool: ConnectionPool,
    stateManager: ConnectionStateManager,
    // messageQueue: MessageQueueService // TODO: Implement message queue service
  ) {
    this.connectionPool = connectionPool;
    this.stateManager = stateManager;
    // this.messageQueue = messageQueue; // TODO: Implement message queue service

    this.setupServiceListeners();
  }

  /**
   * Initialize health status
   */
  private initializeStatus(): HealthStatus {
    return {
      status: "healthy",
      timestamp: new Date(),
      uptime: 0,
      connections: {
        total: 0,
        active: 0,
        failed: 0,
        recovering: 0,
      },
      resources: {
        cpu: 0,
        memory: {
          used: 0,
          total: 0,
          percentage: 0,
        },
      },
      queue: {
        waiting: 0,
        active: 0,
        failed: 0,
        delayed: 0,
      },
      errors: {
        count: 0,
        recent: [],
      },
      lastCheck: new Date(),
      nextCheck: new Date(Date.now() + this.config.checkInterval),
    };
  }

  /**
   * Start health monitoring
   */
  private startMonitoring() {
    // Initial check
    this.performHealthCheck();

    // Schedule regular checks
    this.checkInterval = setInterval(() => {
      this.performHealthCheck();
    }, this.config.checkInterval);
  }

  /**
   * Perform health check
   */
  private async performHealthCheck() {
    try {
      // Update system metrics
      await this.updateSystemMetrics();

      // Update service metrics
      await this.updateServiceMetrics();

      // Evaluate health status
      this.evaluateHealth();

      // Perform recovery if needed
      if (this.config.autoRecovery && this.status.status !== "healthy") {
        await this.performRecovery();
      }

      // Persist status
      await this.persistStatus();

      // Emit status event
      this.emit("health-check", this.status);

      this.logger.debug(
        { status: this.status.status },
        "Health check completed",
      );
    } catch (error) {
      this.logger.error({ error }, "Health check failed");
      this.recordError("Health check failed: " + (error as Error).message);
    }
  }

  /**
   * Update system metrics
   */
  private async updateSystemMetrics() {
    // CPU usage
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach((cpu) => {
      for (const type in cpu.times) {
        totalTick += (cpu.times as any)[type];
      }
      totalIdle += cpu.times.idle;
    });

    const idle = totalIdle / cpus.length;
    const total = totalTick / cpus.length;
    const cpuUsage = 100 - ~~((100 * idle) / total);

    // Memory usage
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercentage = (usedMem / totalMem) * 100;

    this.status.resources = {
      cpu: cpuUsage,
      memory: {
        used: usedMem,
        total: totalMem,
        percentage: memPercentage,
      },
    };

    this.status.uptime = process.uptime();
  }

  /**
   * Update service metrics
   */
  private async updateServiceMetrics() {
    // Connection metrics
    if (this.connectionPool) {
      const poolMetrics = this.connectionPool.getMetrics();
      this.status.connections = {
        total: poolMetrics.totalConnections,
        active: poolMetrics.activeConnections,
        failed: poolMetrics.totalConnections - poolMetrics.activeConnections,
        recovering: poolMetrics.pendingConnections,
      };
    }

    // Queue metrics - TODO: Implement when message queue service is added
    // if (this.messageQueue) {
    //   const queueMetrics = await this.messageQueue.getQueueMetrics();
    //   this.status.queue = {
    //     waiting: queueMetrics.waiting,
    //     active: queueMetrics.active,
    //     failed: queueMetrics.failed,
    //     delayed: queueMetrics.delayed
    //   };
    // }

    // Error metrics
    this.status.errors = {
      count: this.recentErrors.length,
      recent: this.recentErrors.slice(-5),
    };

    this.status.lastCheck = new Date();
    this.status.nextCheck = new Date(Date.now() + this.config.checkInterval);
  }

  /**
   * Evaluate overall health status
   */
  private evaluateHealth() {
    const issues: string[] = [];

    // Check CPU usage
    if (this.status.resources.cpu > this.config.cpuThreshold) {
      issues.push(`High CPU usage: ${this.status.resources.cpu}%`);
    }

    // Check memory usage
    if (this.status.resources.memory.percentage > this.config.memoryThreshold) {
      issues.push(
        `High memory usage: ${this.status.resources.memory.percentage.toFixed(1)}%`,
      );
    }

    // Check error rate
    if (this.status.errors.count > this.config.maxErrors) {
      issues.push(`High error rate: ${this.status.errors.count} errors`);
    }

    // Check connection failures
    const failureRate =
      this.status.connections.total > 0
        ? (this.status.connections.failed / this.status.connections.total) * 100
        : 0;

    if (failureRate > 50) {
      issues.push(`High connection failure rate: ${failureRate.toFixed(1)}%`);
    }

    // Check queue backlog
    if (this.status.queue.waiting > 100) {
      issues.push(`Large queue backlog: ${this.status.queue.waiting} messages`);
    }

    // Determine health status
    if (issues.length === 0) {
      this.status.status = "healthy";
    } else if (issues.length <= 2) {
      this.status.status = "degraded";
      this.logger.warn({ issues }, "System degraded");
    } else {
      this.status.status = "unhealthy";
      this.logger.error({ issues }, "System unhealthy");

      // Trigger alert if threshold exceeded
      if (issues.length >= this.config.alertThreshold) {
        this.triggerAlert(issues);
      }
    }
  }

  /**
   * Perform recovery actions
   */
  private async performRecovery() {
    const recoveryActions: RecoveryAction[] = [];

    // Recover failed connections
    if (this.status.connections.failed > 0 && this.stateManager) {
      const staleConnections = await this.stateManager.getActiveConnections();

      for (const conn of staleConnections) {
        const key = `${conn.userId}:${conn.phoneNumber}`;

        if (!this.recoveryInProgress.has(key)) {
          this.recoveryInProgress.add(key);

          const action: RecoveryAction = {
            type: "restart_connection",
            target: key,
            reason: "Connection failed",
            timestamp: new Date(),
          };

          try {
            // Attempt to restart connection
            if (this.connectionPool) {
              await this.connectionPool.addConnection(
                conn.userId,
                conn.phoneNumber,
              );
            }

            action.success = true;
            this.logger.info({ connection: key }, "Connection recovered");
          } catch (error) {
            action.success = false;
            action.error = (error as Error).message;
            this.logger.error(
              { connection: key, error },
              "Failed to recover connection",
            );
          } finally {
            this.recoveryInProgress.delete(key);
          }

          recoveryActions.push(action);
        }
      }
    }

    // Clear stuck queue jobs if needed
    // TODO: Implement message queue cleanup when service is added
    // if (this.status.queue.failed > 10 && this.messageQueue) {
    if (false) {
      // Disabled until message queue service is implemented
      const action: RecoveryAction = {
        type: "clear_queue",
        reason: "Too many failed jobs",
        timestamp: new Date(),
      };

      try {
        // const retried = await this.messageQueue.retryDeadLetterMessages(5);
        const retried = 0; // Placeholder
        action.success = true;
        this.logger.info({ count: retried }, "Retried failed messages");
      } catch (error) {
        action.success = false;
        action.error = (error as Error).message;
      }

      recoveryActions.push(action);
    }

    // Log recovery actions
    if (recoveryActions.length > 0) {
      await this.logRecoveryActions(recoveryActions);
    }
  }

  /**
   * Setup error handlers
   */
  private setupErrorHandlers() {
    // Process errors
    process.on("uncaughtException", (error) => {
      this.logger.fatal({ error }, "Uncaught exception");
      this.recordError(`Uncaught exception: ${error.message}`);

      // Graceful shutdown
      this.shutdown().then(() => {
        process.exit(1);
      });
    });

    process.on("unhandledRejection", (reason, promise) => {
      this.logger.error({ reason, promise }, "Unhandled rejection");
      this.recordError(`Unhandled rejection: ${reason}`);
    });

    // Memory warnings
    process.on("warning", (warning) => {
      this.logger.warn({ warning }, "Process warning");
      this.recordError(`Warning: ${warning.message}`);
    });
  }

  /**
   * Setup service listeners
   */
  private setupServiceListeners() {
    // Connection pool events
    if (this.connectionPool) {
      this.connectionPool.on("capacity-reached", () => {
        this.recordError("Connection pool capacity reached");
      });

      this.connectionPool.on("memory-threshold-exceeded", () => {
        this.recordError("Memory threshold exceeded");
      });
    }

    // State manager events
    if (this.stateManager) {
      this.stateManager.on("connection-stale", ({ userId, phoneNumber }) => {
        this.recordError(`Connection stale: ${userId}/${phoneNumber}`);
      });
    }
  }

  /**
   * Record error
   */
  private recordError(error: string) {
    this.recentErrors.push(`${new Date().toISOString()}: ${error}`);

    // Keep only recent errors
    if (this.recentErrors.length > 100) {
      this.recentErrors = this.recentErrors.slice(-100);
    }
  }

  /**
   * Trigger alert
   */
  private async triggerAlert(issues: string[]) {
    try {
      await this.firestore.collection("health_alerts").add({
        timestamp: admin.firestore.Timestamp.now(),
        status: this.status.status,
        issues,
        metrics: {
          cpu: this.status.resources.cpu,
          memory: this.status.resources.memory.percentage,
          connections: this.status.connections,
          queue: this.status.queue,
          errors: this.status.errors.count,
        },
      });

      this.logger.error({ issues }, "Health alert triggered");

      // Emit alert event
      this.emit("health-alert", {
        status: this.status,
        issues,
      });
    } catch (error) {
      this.logger.error({ error }, "Failed to trigger alert");
    }
  }

  /**
   * Log recovery actions
   */
  private async logRecoveryActions(actions: RecoveryAction[]) {
    try {
      for (const action of actions) {
        await this.firestore.collection("recovery_actions").add({
          ...action,
          timestamp: admin.firestore.Timestamp.fromDate(action.timestamp),
        });
      }
    } catch (error) {
      this.logger.error({ error }, "Failed to log recovery actions");
    }
  }

  /**
   * Persist health status
   */
  private async persistStatus() {
    try {
      await this.firestore
        .collection("health_status")
        .doc("current")
        .set({
          ...this.status,
          timestamp: admin.firestore.Timestamp.fromDate(this.status.timestamp),
          lastCheck: admin.firestore.Timestamp.fromDate(this.status.lastCheck),
          nextCheck: admin.firestore.Timestamp.fromDate(this.status.nextCheck),
        });

      // Also log to time series collection for history
      await this.firestore.collection("health_history").add({
        ...this.status,
        timestamp: admin.firestore.Timestamp.now(),
      });
    } catch (error) {
      this.logger.error({ error }, "Failed to persist health status");
    }
  }

  /**
   * Get current health status
   */
  getStatus(): HealthStatus {
    return { ...this.status };
  }

  /**
   * Force health check
   */
  async forceCheck(): Promise<HealthStatus> {
    await this.performHealthCheck();
    return this.getStatus();
  }

  /**
   * Shutdown health monitor
   */
  async shutdown() {
    this.logger.info("Shutting down health monitor");

    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    // Final status update
    this.status.status = "unhealthy";
    await this.persistStatus();

    this.logger.info("Health monitor shutdown complete");
  }
}
