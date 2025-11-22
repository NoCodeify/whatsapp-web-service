import pino from "pino";
import { EventEmitter } from "events";

export interface ErrorContext {
  userId?: string;
  phoneNumber?: string;
  connectionId?: string;
  operation?: string;
  errorCode?: string;
  timestamp: Date;
  stackTrace?: string;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  recoveryTimeout: number;
  monitoringPeriod: number;
}

export interface ErrorHandlingConfig {
  maxRetries: number;
  retryDelay: number;
  exponentialBackoff: boolean;
  circuitBreaker: CircuitBreakerConfig;
  enableGracefulDegradation: boolean;
}

enum CircuitBreakerState {
  CLOSED = "closed",
  OPEN = "open",
  HALF_OPEN = "half_open",
}

/**
 * Comprehensive error handling service for WhatsApp Web Service
 * Implements circuit breakers, graceful degradation, and error recovery
 */
export class ErrorHandler extends EventEmitter {
  private logger = pino({ name: "ErrorHandler" });

  // Circuit breaker state per operation type
  private circuitBreakers: Map<
    string,
    {
      state: CircuitBreakerState;
      failures: number;
      lastFailureTime: Date;
      nextRetryTime: Date;
    }
  > = new Map();

  // Error statistics
  private errorStats: Map<
    string,
    {
      count: number;
      lastOccurrence: Date;
      severity: "low" | "medium" | "high" | "critical";
    }
  > = new Map();

  // Recovery strategies
  private recoveryStrategies: Map<string, (context: ErrorContext) => Promise<boolean>> = new Map();

  private readonly config: ErrorHandlingConfig = {
    maxRetries: parseInt(process.env.ERROR_MAX_RETRIES || "3"),
    retryDelay: parseInt(process.env.ERROR_RETRY_DELAY || "1000"),
    exponentialBackoff: process.env.ERROR_EXPONENTIAL_BACKOFF !== "false",
    circuitBreaker: {
      failureThreshold: parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD || "5"),
      recoveryTimeout: parseInt(process.env.CIRCUIT_BREAKER_RECOVERY || "30000"),
      monitoringPeriod: parseInt(process.env.CIRCUIT_BREAKER_MONITOR || "60000"),
    },
    enableGracefulDegradation: process.env.GRACEFUL_DEGRADATION !== "false",
  };

  constructor() {
    super();
    this.setupGlobalErrorHandlers();
    this.initializeRecoveryStrategies();
    this.startCircuitBreakerMonitoring();

    this.logger.info(this.config, "ErrorHandler initialized");
  }

  /**
   * Handle an error with context and attempt recovery
   */
  async handleError(error: Error, context: ErrorContext): Promise<boolean> {
    const errorKey = this.getErrorKey(error, context);

    // Update error statistics
    this.updateErrorStats(errorKey, error);

    // Log the error with context
    this.logError(error, context);

    // Check circuit breaker state
    if (this.isCircuitOpen(errorKey)) {
      this.logger.warn({ errorKey, context }, "Circuit breaker is open, skipping recovery attempt");
      return false;
    }

    // Attempt recovery based on error type
    const recovered = await this.attemptRecovery(error, context);

    // Update circuit breaker state
    this.updateCircuitBreaker(errorKey, recovered);

    return recovered;
  }

  /**
   * Register a recovery strategy for a specific error type
   */
  registerRecoveryStrategy(errorType: string, strategy: (context: ErrorContext) => Promise<boolean>): void {
    this.recoveryStrategies.set(errorType, strategy);
    this.logger.debug({ errorType }, "Recovery strategy registered");
  }

  /**
   * Execute an operation with error handling and retries
   */
  async executeWithRetry<T>(operation: () => Promise<T>, context: ErrorContext, maxRetries?: number): Promise<T> {
    const retries = maxRetries ?? this.config.maxRetries;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        const isLastAttempt = attempt === retries;

        if (isLastAttempt) {
          await this.handleError(error as Error, {
            ...context,
            operation: context.operation || "executeWithRetry",
          });
          throw error;
        }

        // Calculate delay with exponential backoff
        const delay = this.config.exponentialBackoff ? this.config.retryDelay * Math.pow(2, attempt) : this.config.retryDelay;

        this.logger.warn(
          {
            attempt,
            maxRetries: retries,
            delay,
            error: (error as Error).message,
            context,
          },
          "Operation failed, retrying"
        );

        await this.sleep(delay);
      }
    }

    // This should never be reached, but TypeScript requires it
    throw new Error("Max retries exceeded");
  }

  /**
   * Setup global error handlers to prevent process crashes
   */
  private setupGlobalErrorHandlers(): void {
    // Handle uncaught exceptions
    process.on("uncaughtException", (error) => {
      this.logger.fatal({ error }, "Uncaught exception detected");

      this.handleError(error, {
        operation: "uncaughtException",
        timestamp: new Date(),
        stackTrace: error.stack,
      }).then((recovered) => {
        if (!recovered) {
          this.logger.fatal("Failed to recover from uncaught exception, initiating graceful shutdown");
          this.gracefulShutdown();
        }
      });
    });

    // Handle unhandled promise rejections
    process.on("unhandledRejection", (reason, promise) => {
      this.logger.error({ reason, promise }, "Unhandled promise rejection");

      const error = reason instanceof Error ? reason : new Error(String(reason));

      this.handleError(error, {
        operation: "unhandledRejection",
        timestamp: new Date(),
        stackTrace: error.stack,
      });
    });

    // Handle warnings
    process.on("warning", (warning) => {
      this.logger.warn({ warning }, "Process warning");

      // Don't treat warnings as errors that need recovery
      this.updateErrorStats("process_warning", new Error(warning.message));
    });
  }

  /**
   * Initialize built-in recovery strategies
   */
  private initializeRecoveryStrategies(): void {
    // WebSocket connection errors
    this.registerRecoveryStrategy("websocket_error", async (context) => {
      this.logger.info({ context }, "Attempting WebSocket recovery");

      // Emit recovery event for connection pool to handle
      this.emit("websocket-recovery-needed", context);

      return true; // Let the connection pool handle the actual recovery
    });

    // Stream errors (Baileys specific)
    this.registerRecoveryStrategy("stream_error", async (context) => {
      this.logger.info({ context }, "Attempting stream error recovery");

      // For stream errors, we typically need to restart the connection
      this.emit("connection-restart-needed", context);

      return true;
    });

    // Timeout errors
    this.registerRecoveryStrategy("timeout_error", async (context) => {
      this.logger.info({ context }, "Attempting timeout error recovery");

      // For timeouts, try to refresh the connection
      this.emit("connection-refresh-needed", context);

      return true;
    });

    // Connection closed errors
    this.registerRecoveryStrategy("connection_closed", async (context) => {
      this.logger.info({ context }, "Attempting connection closed recovery");

      // Attempt reconnection
      this.emit("reconnection-needed", context);

      return true;
    });
  }

  /**
   * Attempt to recover from an error
   */
  private async attemptRecovery(error: Error, context: ErrorContext): Promise<boolean> {
    const errorType = this.categorizeError(error);

    const strategy = this.recoveryStrategies.get(errorType);
    if (!strategy) {
      this.logger.warn({ errorType, error: error.message }, "No recovery strategy available for error type");
      return false;
    }

    try {
      const recovered = await strategy(context);

      if (recovered) {
        this.logger.info({ errorType, context }, "Error recovery successful");
      } else {
        this.logger.warn({ errorType, context }, "Error recovery failed");
      }

      return recovered;
    } catch (recoveryError) {
      this.logger.error({ errorType, recoveryError, originalError: error }, "Recovery strategy threw an error");
      return false;
    }
  }

  /**
   * Categorize error for recovery strategy selection
   */
  private categorizeError(error: Error): string {
    const message = error.message.toLowerCase();
    const stack = error.stack?.toLowerCase() || "";

    if (message.includes("stream errored") || message.includes("stream error")) {
      return "stream_error";
    }

    if (message.includes("connection closed") || message.includes("connection lost")) {
      return "connection_closed";
    }

    if (message.includes("timeout") || message.includes("timed out")) {
      return "timeout_error";
    }

    if (message.includes("websocket") || stack.includes("websocket")) {
      return "websocket_error";
    }

    if (message.includes("memory") || message.includes("heap")) {
      return "memory_error";
    }

    if (message.includes("econnrefused") || message.includes("enotfound")) {
      return "network_error";
    }

    return "unknown_error";
  }

  /**
   * Get error key for tracking
   */
  private getErrorKey(error: Error, context: ErrorContext): string {
    const errorType = this.categorizeError(error);
    return context.connectionId ? `${errorType}_${context.connectionId}` : errorType;
  }

  /**
   * Update error statistics
   */
  private updateErrorStats(errorKey: string, error: Error): void {
    const existing = this.errorStats.get(errorKey);

    if (existing) {
      existing.count++;
      existing.lastOccurrence = new Date();
    } else {
      this.errorStats.set(errorKey, {
        count: 1,
        lastOccurrence: new Date(),
        severity: this.determineSeverity(error),
      });
    }
  }

  /**
   * Determine error severity
   */
  private determineSeverity(error: Error): "low" | "medium" | "high" | "critical" {
    const message = error.message.toLowerCase();

    if (message.includes("fatal") || message.includes("critical")) {
      return "critical";
    }

    if (message.includes("connection closed") || message.includes("stream errored")) {
      return "high";
    }

    if (message.includes("timeout") || message.includes("websocket")) {
      return "medium";
    }

    return "low";
  }

  /**
   * Circuit breaker management
   */
  private isCircuitOpen(errorKey: string): boolean {
    const circuit = this.circuitBreakers.get(errorKey);
    if (!circuit) return false;

    if (circuit.state === CircuitBreakerState.OPEN) {
      if (Date.now() > circuit.nextRetryTime.getTime()) {
        circuit.state = CircuitBreakerState.HALF_OPEN;
        this.logger.info({ errorKey }, "Circuit breaker moved to half-open state");
        return false;
      }
      return true;
    }

    return false;
  }

  private updateCircuitBreaker(errorKey: string, success: boolean): void {
    const circuit = this.circuitBreakers.get(errorKey) || {
      state: CircuitBreakerState.CLOSED,
      failures: 0,
      lastFailureTime: new Date(),
      nextRetryTime: new Date(),
    };

    if (success) {
      if (circuit.state === CircuitBreakerState.HALF_OPEN) {
        circuit.state = CircuitBreakerState.CLOSED;
        circuit.failures = 0;
        this.logger.info({ errorKey }, "Circuit breaker reset to closed state");
      }
    } else {
      circuit.failures++;
      circuit.lastFailureTime = new Date();

      if (circuit.failures >= this.config.circuitBreaker.failureThreshold) {
        circuit.state = CircuitBreakerState.OPEN;
        circuit.nextRetryTime = new Date(Date.now() + this.config.circuitBreaker.recoveryTimeout);

        this.logger.warn({ errorKey, failures: circuit.failures }, "Circuit breaker tripped to open state");
      }
    }

    this.circuitBreakers.set(errorKey, circuit);
  }

  /**
   * Start circuit breaker monitoring
   */
  private startCircuitBreakerMonitoring(): void {
    setInterval(() => {
      const now = Date.now();

      for (const [errorKey, circuit] of this.circuitBreakers.entries()) {
        const timeSinceLastFailure = now - circuit.lastFailureTime.getTime();

        // Reset circuit breaker if no failures for a while
        if (timeSinceLastFailure > this.config.circuitBreaker.monitoringPeriod) {
          if (circuit.state !== CircuitBreakerState.CLOSED) {
            circuit.state = CircuitBreakerState.CLOSED;
            circuit.failures = 0;
            this.logger.info({ errorKey }, "Circuit breaker auto-reset due to inactivity");
          }
        }
      }
    }, 60000); // Check every minute
  }

  /**
   * Log error with appropriate level
   */
  private logError(error: Error, context: ErrorContext): void {
    const severity = this.determineSeverity(error);

    const logData = {
      error: {
        message: error.message,
        name: error.name,
        stack: error.stack,
      },
      context,
      severity,
    };

    switch (severity) {
      case "critical":
        this.logger.fatal(logData, "Critical error occurred");
        break;
      case "high":
        this.logger.error(logData, "High severity error occurred");
        break;
      case "medium":
        this.logger.warn(logData, "Medium severity error occurred");
        break;
      case "low":
        this.logger.info(logData, "Low severity error occurred");
        break;
    }
  }

  /**
   * Graceful shutdown procedure
   */
  private gracefulShutdown(): void {
    this.logger.info("Initiating graceful shutdown");

    // Emit shutdown event for other services to clean up
    this.emit("graceful-shutdown");

    // Give services time to clean up
    setTimeout(() => {
      process.exit(1);
    }, 30000); // 30 seconds to clean up
  }

  /**
   * Get error handling statistics
   */
  getStats() {
    const circuitBreakerStats = Array.from(this.circuitBreakers.entries()).map(([key, circuit]) => ({
      errorKey: key,
      state: circuit.state,
      failures: circuit.failures,
      lastFailureTime: circuit.lastFailureTime,
    }));

    const errorStatsArray = Array.from(this.errorStats.entries()).map(([key, stats]) => ({
      errorKey: key,
      ...stats,
    }));

    return {
      circuitBreakers: circuitBreakerStats,
      errorStats: errorStatsArray,
      config: this.config,
    };
  }

  /**
   * Utility method for sleeping
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Shutdown error handler
   */
  shutdown(): void {
    this.logger.info("Shutting down error handler");

    // Clear all circuit breakers
    this.circuitBreakers.clear();
    this.errorStats.clear();
    this.recoveryStrategies.clear();

    this.logger.info("Error handler shutdown complete");
  }
}
