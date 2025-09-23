"use strict";
var __createBinding =
  (this && this.__createBinding) ||
  (Object.create
    ? function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        var desc = Object.getOwnPropertyDescriptor(m, k);
        if (
          !desc ||
          ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)
        ) {
          desc = {
            enumerable: true,
            get: function () {
              return m[k];
            },
          };
        }
        Object.defineProperty(o, k2, desc);
      }
    : function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        o[k2] = m[k];
      });
var __setModuleDefault =
  (this && this.__setModuleDefault) ||
  (Object.create
    ? function (o, v) {
        Object.defineProperty(o, "default", { enumerable: true, value: v });
      }
    : function (o, v) {
        o["default"] = v;
      });
var __importStar =
  (this && this.__importStar) ||
  (function () {
    var ownKeys = function (o) {
      ownKeys =
        Object.getOwnPropertyNames ||
        function (o) {
          var ar = [];
          for (var k in o)
            if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
          return ar;
        };
      return ownKeys(o);
    };
    return function (mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null)
        for (var k = ownKeys(mod), i = 0; i < k.length; i++)
          if (k[i] !== "default") __createBinding(result, mod, k[i]);
      __setModuleDefault(result, mod);
      return result;
    };
  })();
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, "__esModule", { value: true });
exports.HealthMonitor = void 0;
const events_1 = require("events");
const pino_1 = __importDefault(require("pino"));
const admin = __importStar(require("firebase-admin"));
const os_1 = __importDefault(require("os"));
class HealthMonitor extends events_1.EventEmitter {
  logger = (0, pino_1.default)({ name: "HealthMonitor" });
  firestore;
  connectionPool;
  stateManager;
  // private messageQueue?: MessageQueueService; // TODO: Implement message queue service
  status;
  recentErrors = [];
  checkInterval = null;
  recoveryInProgress = new Set();
  config = {
    checkInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL || "30000"),
    maxErrors: parseInt(process.env.MAX_ERRORS_THRESHOLD || "10"),
    cpuThreshold: parseFloat(process.env.CPU_THRESHOLD || "80"),
    memoryThreshold: parseFloat(process.env.MEMORY_THRESHOLD || "85"),
    autoRecovery: process.env.AUTO_RECOVERY !== "false",
    alertThreshold: parseInt(process.env.ALERT_THRESHOLD || "5"),
  };
  constructor(firestore) {
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
  setDependencies(connectionPool, stateManager) {
    this.connectionPool = connectionPool;
    this.stateManager = stateManager;
    // this.messageQueue = messageQueue; // TODO: Implement message queue service
    this.setupServiceListeners();
  }
  /**
   * Initialize health status
   */
  initializeStatus() {
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
  startMonitoring() {
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
  async performHealthCheck() {
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
      this.recordError("Health check failed: " + error.message);
    }
  }
  /**
   * Update system metrics
   */
  async updateSystemMetrics() {
    // CPU usage
    const cpus = os_1.default.cpus();
    let totalIdle = 0;
    let totalTick = 0;
    cpus.forEach((cpu) => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });
    const idle = totalIdle / cpus.length;
    const total = totalTick / cpus.length;
    const cpuUsage = 100 - ~~((100 * idle) / total);
    // Memory usage
    const totalMem = os_1.default.totalmem();
    const freeMem = os_1.default.freemem();
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
  async updateServiceMetrics() {
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
  evaluateHealth() {
    const issues = [];
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
  async performRecovery() {
    const recoveryActions = [];
    // Recover failed connections
    if (this.status.connections.failed > 0 && this.stateManager) {
      const staleConnections = await this.stateManager.getActiveConnections();
      for (const conn of staleConnections) {
        const key = `${conn.userId}:${conn.phoneNumber}`;
        if (!this.recoveryInProgress.has(key)) {
          this.recoveryInProgress.add(key);
          const action = {
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
            action.error = error.message;
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
      const action = {
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
        action.error = error.message;
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
  setupErrorHandlers() {
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
  setupServiceListeners() {
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
  recordError(error) {
    this.recentErrors.push(`${new Date().toISOString()}: ${error}`);
    // Keep only recent errors
    if (this.recentErrors.length > 100) {
      this.recentErrors = this.recentErrors.slice(-100);
    }
  }
  /**
   * Trigger alert
   */
  async triggerAlert(issues) {
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
  async logRecoveryActions(actions) {
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
  async persistStatus() {
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
  getStatus() {
    return { ...this.status };
  }
  /**
   * Force health check
   */
  async forceCheck() {
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
exports.HealthMonitor = HealthMonitor;
//# sourceMappingURL=healthMonitor.js.map
