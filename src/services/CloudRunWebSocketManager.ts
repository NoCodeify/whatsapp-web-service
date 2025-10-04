import { WASocket } from "@whiskeysockets/baileys";
import pino from "pino";
import { EventEmitter } from "events";

export interface WebSocketHealth {
  isConnected: boolean;
  lastPingTime?: Date;
  lastPongTime?: Date;
  consecutiveFailures: number;
  lastError?: string;
}

export interface CloudRunConfig {
  keepAliveInterval: number;
  healthCheckInterval: number;
  maxConsecutiveFailures: number;
  reconnectDelay: number;
  maxReconnectDelay: number;
  connectionTimeout: number;
}

/**
 * Cloud Run optimized WebSocket manager for Baileys connections
 * Implements aggressive monitoring and recovery mechanisms
 */
export class CloudRunWebSocketManager extends EventEmitter {
  private logger = pino({ name: "CloudRunWebSocketManager" });
  private healthChecks: Map<string, WebSocketHealth> = new Map();
  private keepAliveTimers: Map<string, NodeJS.Timeout> = new Map();
  private healthCheckTimers: Map<string, NodeJS.Timeout> = new Map();

  private readonly config: CloudRunConfig = {
    keepAliveInterval: parseInt(process.env.WS_KEEPALIVE_INTERVAL || "20000"), // 20 seconds
    healthCheckInterval: parseInt(
      process.env.WS_HEALTH_CHECK_INTERVAL || "30000",
    ), // 30 seconds
    maxConsecutiveFailures: parseInt(process.env.WS_MAX_FAILURES || "3"),
    reconnectDelay: parseInt(process.env.WS_RECONNECT_DELAY || "5000"), // 5 seconds
    maxReconnectDelay: parseInt(process.env.WS_MAX_RECONNECT_DELAY || "60000"), // 60 seconds
    connectionTimeout: parseInt(process.env.WS_CONNECTION_TIMEOUT || "120000"), // 120 seconds
  };

  constructor() {
    super();
    this.logger.info(this.config, "CloudRunWebSocketManager initialized");
  }

  /**
   * Register a WebSocket connection for monitoring
   */
  registerConnection(connectionId: string, socket: WASocket): void {
    this.logger.info({ connectionId }, "Registering WebSocket for monitoring");

    // Initialize health status
    this.healthChecks.set(connectionId, {
      isConnected: true,
      consecutiveFailures: 0,
      lastPongTime: new Date(), // Initialize with current time to prevent false stale detection
    });

    // Set up keep-alive monitoring
    this.setupKeepAlive(connectionId, socket);

    // Set up connection health monitoring
    this.setupHealthCheck(connectionId, socket);

    // Monitor WebSocket-specific events
    this.setupWebSocketMonitoring(connectionId, socket);
  }

  /**
   * Unregister a WebSocket connection
   */
  unregisterConnection(connectionId: string): void {
    this.logger.info({ connectionId }, "Unregistering WebSocket");

    // Clear timers
    const keepAliveTimer = this.keepAliveTimers.get(connectionId);
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      this.keepAliveTimers.delete(connectionId);
    }

    const healthTimer = this.healthCheckTimers.get(connectionId);
    if (healthTimer) {
      clearInterval(healthTimer);
      this.healthCheckTimers.delete(connectionId);
    }

    // Remove health data
    this.healthChecks.delete(connectionId);
  }

  /**
   * Get health status for a connection
   */
  getConnectionHealth(connectionId: string): WebSocketHealth | undefined {
    return this.healthChecks.get(connectionId);
  }

  /**
   * Get all connection health statuses
   */
  getAllConnectionHealth(): Map<string, WebSocketHealth> {
    return new Map(this.healthChecks);
  }

  /**
   * Setup keep-alive mechanism
   */
  private setupKeepAlive(connectionId: string, socket: WASocket): void {
    const timer = setInterval(async () => {
      try {
        await this.sendKeepAlive(connectionId, socket);
      } catch (error) {
        this.logger.error({ connectionId, error }, "Keep-alive failed");
        this.handleConnectionError(connectionId, error as Error);
      }
    }, this.config.keepAliveInterval);

    this.keepAliveTimers.set(connectionId, timer);
  }

  /**
   * Setup health check monitoring
   */
  private setupHealthCheck(connectionId: string, socket: WASocket): void {
    const timer = setInterval(() => {
      this.performHealthCheck(connectionId, socket);
    }, this.config.healthCheckInterval);

    this.healthCheckTimers.set(connectionId, timer);
  }

  /**
   * Setup WebSocket-specific monitoring
   */
  private setupWebSocketMonitoring(
    connectionId: string,
    socket: WASocket,
  ): void {
    // Monitor connection state changes
    socket.ev.on("connection.update", (update) => {
      const health = this.healthChecks.get(connectionId);
      if (health) {
        health.isConnected = update.connection === "open";
        if (update.connection === "open") {
          health.consecutiveFailures = 0;
          health.lastError = undefined;
        }
      }
    });

    // Monitor for WebSocket errors that might not trigger disconnection
    if (socket.ws) {
      socket.ws.on("error", (error: Error) => {
        this.logger.error(
          { connectionId, error: error.message },
          "WebSocket error detected",
        );
        this.handleConnectionError(connectionId, error);
      });

      socket.ws.on("close", (code: number, reason: string) => {
        this.logger.warn(
          { connectionId, code, reason },
          "WebSocket closed unexpectedly",
        );
        this.handleConnectionError(
          connectionId,
          new Error(`WebSocket closed: ${code} ${reason}`),
        );
      });
    }
  }

  /**
   * Send keep-alive ping
   */
  private async sendKeepAlive(
    connectionId: string,
    socket: WASocket,
  ): Promise<void> {
    const health = this.healthChecks.get(connectionId);
    if (!health || !health.isConnected) {
      return;
    }

    try {
      // Send a lightweight query to keep the connection alive
      // Using presence query as it's minimal
      const pingTime = new Date();

      // Create a promise that times out if no response
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error("Keep-alive timeout")),
          this.config.connectionTimeout,
        );
      });

      // Send a minimal query (we use getBusinessProfile as it's lightweight)
      const queryPromise = socket
        .query({
          tag: "iq",
          attrs: {
            id: socket.generateMessageTag(),
            type: "get",
            to: socket.user?.id || "",
          },
          content: [
            {
              tag: "w:profile:business",
              attrs: {},
            },
          ],
        })
        .catch(() => {
          // Ignore query failures, we just want to test connectivity
        });

      await Promise.race([queryPromise, timeoutPromise]);

      health.lastPingTime = pingTime;
      health.lastPongTime = new Date();
      health.consecutiveFailures = 0;

      this.logger.debug({ connectionId }, "Keep-alive successful");
    } catch (error) {
      throw new Error(`Keep-alive failed: ${(error as Error).message}`);
    }
  }

  /**
   * Perform health check
   */
  private performHealthCheck(connectionId: string, socket: WASocket): void {
    const health = this.healthChecks.get(connectionId);
    if (!health) return;

    const now = new Date();

    // Check if connection is stale
    const timeSinceLastPong = health.lastPongTime
      ? now.getTime() - health.lastPongTime.getTime()
      : Number.MAX_SAFE_INTEGER;

    const isStale = timeSinceLastPong > this.config.healthCheckInterval * 2;

    if (isStale && health.isConnected) {
      this.logger.warn(
        {
          connectionId,
          timeSinceLastPong: Math.round(timeSinceLastPong / 1000),
          threshold: Math.round((this.config.healthCheckInterval * 2) / 1000),
        },
        "Connection appears stale - no recent activity",
      );

      this.handleConnectionError(connectionId, new Error("Connection stale"));
    }

    // Check WebSocket readyState if available
    if (socket.ws) {
      const readyState = (socket.ws as any).readyState;
      if (readyState === 2 || readyState === 3) {
        // CLOSING or CLOSED
        this.logger.warn(
          { connectionId, readyState },
          "WebSocket is closing or closed",
        );
        health.isConnected = false;
        this.handleConnectionError(
          connectionId,
          new Error(`WebSocket readyState: ${readyState}`),
        );
      }
    }
  }

  /**
   * Handle connection errors
   */
  private handleConnectionError(connectionId: string, error: Error): void {
    const health = this.healthChecks.get(connectionId);
    if (!health) return;

    health.consecutiveFailures++;
    health.lastError = error.message;

    this.logger.error(
      {
        connectionId,
        consecutiveFailures: health.consecutiveFailures,
        maxFailures: this.config.maxConsecutiveFailures,
        error: error.message,
      },
      "Connection error recorded",
    );

    // Emit error event for connection pool to handle
    this.emit("connection-error", {
      connectionId,
      error,
      consecutiveFailures: health.consecutiveFailures,
      shouldReconnect:
        health.consecutiveFailures >= this.config.maxConsecutiveFailures,
    });

    // If max failures reached, mark as disconnected
    if (health.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      health.isConnected = false;
      this.logger.error(
        { connectionId },
        "Max consecutive failures reached, marking connection as failed",
      );
    }
  }

  /**
   * Force refresh of a connection's health status
   */
  async refreshConnectionHealth(
    connectionId: string,
    socket: WASocket,
  ): Promise<void> {
    try {
      await this.sendKeepAlive(connectionId, socket);
      const health = this.healthChecks.get(connectionId);
      if (health) {
        health.consecutiveFailures = 0;
        health.isConnected = true;
        health.lastError = undefined;
      }
    } catch (error) {
      this.handleConnectionError(connectionId, error as Error);
    }
  }

  /**
   * Get metrics for monitoring
   */
  getMetrics() {
    const connections = Array.from(this.healthChecks.entries());

    return {
      totalConnections: connections.length,
      healthyConnections: connections.filter(
        ([_, health]) => health.isConnected && health.consecutiveFailures === 0,
      ).length,
      degradedConnections: connections.filter(
        ([_, health]) => health.isConnected && health.consecutiveFailures > 0,
      ).length,
      failedConnections: connections.filter(
        ([_, health]) => !health.isConnected,
      ).length,
      averageFailures:
        connections.length > 0
          ? connections.reduce(
              (sum, [_, health]) => sum + health.consecutiveFailures,
              0,
            ) / connections.length
          : 0,
    };
  }

  /**
   * Shutdown manager and clean up all timers
   */
  shutdown(): void {
    this.logger.info("Shutting down CloudRunWebSocketManager");

    // Clear all timers
    for (const timer of this.keepAliveTimers.values()) {
      clearInterval(timer);
    }
    for (const timer of this.healthCheckTimers.values()) {
      clearInterval(timer);
    }

    // Clear data
    this.keepAliveTimers.clear();
    this.healthCheckTimers.clear();
    this.healthChecks.clear();

    this.logger.info("CloudRunWebSocketManager shutdown complete");
  }
}
