import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import { createServer } from "http";
import { Server as SocketServer } from "socket.io";
import pino from "pino";
import { Firestore } from "@google-cloud/firestore";
import { PubSub } from "@google-cloud/pubsub";
// import { Storage } from "@google-cloud/storage"; // Commented out - not currently used
import * as dotenv from "dotenv";

// Core modules
import { ProxyManager } from "./core/ProxyManager";
import { SessionManager } from "./core/SessionManager";
import { ConnectionPool } from "./core/ConnectionPool";
import { ConnectionStateManager } from "./services/connectionStateManager";
import { StatusReconciliationService } from "./services/statusReconciliation";
import { DynamicProxyService } from "./services/DynamicProxyService";
import { SessionRecoveryService } from "./services/SessionRecoveryService";
import { ReconnectionService } from "./services/ReconnectionService";
import { InstanceCoordinator } from "./services/InstanceCoordinator";
import { CloudRunWebSocketManager } from "./services/CloudRunWebSocketManager";
import { ErrorHandler } from "./services/ErrorHandler";
// import { CloudRunSessionOptimizer } from "./services/CloudRunSessionOptimizer"; // Commented out - not currently used

// API routes
import { createApiRoutes } from "./api/routes";
import { createWebSocketHandlers } from "./api/websocket";

// Load environment variables
dotenv.config();

// Initialize logger
const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "HH:MM:ss Z",
      ignore: "pid,hostname",
    },
  },
});

// Initialize services
const firestore = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
});

const pubsub = new PubSub({
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
});

// const storage = new Storage({
//   projectId: process.env.GOOGLE_CLOUD_PROJECT,
// }); // Commented out - not currently used

// Initialize recovery services (only if proxy type is ISP)
let dynamicProxyService: DynamicProxyService | undefined;
let sessionRecoveryService: SessionRecoveryService | undefined;

// Always initialize ISP proxy services since we hardcode to ISP
dynamicProxyService = new DynamicProxyService();
sessionRecoveryService = new SessionRecoveryService(firestore, `instance_${process.env.HOSTNAME || "unknown"}_${Date.now()}`);

// Initialize core components with proper dependencies
const proxyManager = new ProxyManager(firestore, dynamicProxyService);
const sessionManager = new SessionManager(proxyManager, firestore);
const connectionStateManager = new ConnectionStateManager(firestore);

// Initialize status reconciliation service
const statusReconciliationService = new StatusReconciliationService(firestore, connectionStateManager);

// Set up reconciliation event listeners for monitoring
statusReconciliationService.on("reconciliation-complete", (metrics) => {
  logger.info(
    {
      duration: metrics.duration,
      inMemoryCount: metrics.inMemoryCount,
      firestoreCount: metrics.firestoreCount,
      desyncsFound: metrics.desyncsFound,
      desyncsFixed: metrics.desyncsFixed,
      desyncsFailed: metrics.desyncsFailed,
    },
    "Status reconciliation completed"
  );
});

statusReconciliationService.on("excessive-desyncs", (data) => {
  logger.error(
    {
      count: data.count,
      threshold: data.threshold,
      desyncs: data.desyncs,
    },
    "ALERT: Excessive desyncs detected!"
  );
});

statusReconciliationService.on("reconciliation-error", (data) => {
  logger.error(
    {
      error: data.error,
    },
    "Error during reconciliation"
  );
});

// Initialize reconnection service
const reconnectionService = new ReconnectionService(
  sessionManager,
  undefined as any, // Will be set after connectionPool is created
  firestore
);

// Initialize Cloud Run optimization services BEFORE ConnectionPool
const instanceCoordinator = new InstanceCoordinator(firestore);
const webSocketManager = new CloudRunWebSocketManager();
const errorHandler = new ErrorHandler();

const connectionPool = new ConnectionPool(
  proxyManager,
  sessionManager,
  firestore,
  pubsub,
  connectionStateManager,
  webSocketManager,
  errorHandler,
  instanceCoordinator
);

// Set connection pool reference for recovery service
if (sessionRecoveryService) {
  sessionRecoveryService.setConnectionPool(connectionPool);
  sessionRecoveryService.setInstanceCoordinator(instanceCoordinator);
}

// Set connection pool reference for status reconciliation service
statusReconciliationService.setConnectionPool(connectionPool);

// Set connection pool reference for reconnection service
(reconnectionService as any).connectionPool = connectionPool;
// const sessionOptimizer = new CloudRunSessionOptimizer(storage, firestore); // Commented out - not currently used

// Connect services to connection pool events
connectionPool.on("websocket:created", (data) => {
  webSocketManager.registerConnection(data.connectionId, data.socket);
});

connectionPool.on("websocket:closed", (data) => {
  webSocketManager.unregisterConnection(data.connectionId);
});

connectionPool.on("error", (error) => {
  errorHandler.handleError(error, {
    operation: "connection_pool_error",
    timestamp: new Date(),
  });
});

// Create Express app
const app = express();
const server = createServer(app);
const io = new SocketServer(server, {
  cors: {
    origin: process.env.CORS_ORIGIN === "*" ? true : process.env.CORS_ORIGIN?.split(",") || ["http://localhost:3000"],
    credentials: true,
    methods: ["GET", "POST"],
  },
});

// Middleware
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);
app.use(compression());

// Configure CORS with proper options
const corsOptions = {
  origin: (origin: any, callback: any) => {
    // Allow requests with no origin (like mobile apps, Postman)
    if (!origin) return callback(null, true);

    // In development, allow all origins if CORS_ORIGIN is '*'
    if (process.env.CORS_ORIGIN === "*") {
      return callback(null, true);
    }

    // In development mode, allow all localhost origins (Flutter Web uses dynamic ports)
    if (process.env.NODE_ENV === "development" && origin) {
      const isLocalhost =
        origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:") || origin === "http://localhost" || origin === "http://127.0.0.1";

      if (isLocalhost) {
        return callback(null, true);
      }
    }

    // Otherwise, check against allowed origins
    const allowedOrigins = process.env.CORS_ORIGIN?.split(",") || ["http://localhost:3000"];
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-api-key", "x-user-id"],
  preflightContinue: false,
  optionsSuccessStatus: 204,
  maxAge: 86400, // Cache preflight response for 24 hours
};

app.use(cors(corsOptions));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Extend Request type to include correlation ID
declare global {
  namespace Express {
    interface Request {
      correlationId?: string;
      startTime?: number;
    }
  }
}

// Correlation ID middleware - essential for request tracing
app.use((req: Request, res: Response, next: NextFunction) => {
  // Generate or use existing correlation ID
  req.correlationId = (req.headers["x-correlation-id"] as string) || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  req.startTime = Date.now();

  // Set correlation ID in response headers for client tracking
  res.setHeader("x-correlation-id", req.correlationId);

  next();
});

// Enhanced request logging with correlation ID
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = req.startTime || Date.now();

  // Log request received
  logger.info(
    {
      correlationId: req.correlationId,
      method: req.method,
      url: req.url,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      contentLength: req.headers["content-length"],
    },
    "Request received"
  );

  res.on("finish", () => {
    const duration = Date.now() - start;

    // Log request completed with metrics
    logger.info(
      {
        correlationId: req.correlationId,
        method: req.method,
        url: req.url,
        status: res.statusCode,
        duration,
        durationMs: duration,
        contentLength: res.get("content-length"),
        // Add severity based on status code
        ...(res.statusCode >= 500 && { severity: "ERROR" }),
        ...(res.statusCode >= 400 && res.statusCode < 500 && { severity: "WARNING" }),
      },
      `Request completed: ${res.statusCode >= 400 ? "failed" : "success"}`
    );

    // Log slow requests as warnings
    if (duration > 5000) {
      logger.warn(
        {
          correlationId: req.correlationId,
          method: req.method,
          url: req.url,
          duration,
          threshold: 5000,
        },
        "Slow request detected"
      );
    }
  });

  next();
});

// Enhanced health check endpoint with comprehensive Cloud Run monitoring
app.get("/health", async (_req: Request, res: Response) => {
  try {
    const metrics = connectionPool.getMetrics();
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    // Get container memory limit (Cloud Run)
    const getContainerMemoryLimit = (): number => {
      try {
        const fs = require("fs");
        const memLimit = fs.readFileSync("/sys/fs/cgroup/memory/memory.limit_in_bytes", "utf8");
        return parseInt(memLimit.trim());
      } catch {
        // Fallback for non-containerized environments
        return require("os").totalmem();
      }
    };

    const containerMemLimit = getContainerMemoryLimit();
    const rssMemoryPercentage = (memUsage.rss / containerMemLimit) * 100;

    // Get WebSocket metrics
    const webSocketStats = webSocketManager.getMetrics();

    // Get instance coordination metrics
    const coordinationMetrics = instanceCoordinator.getStats();

    // Get error handler statistics
    const errorStats = errorHandler.getStats();

    // Get reconciliation metrics
    const reconciliationMetrics = statusReconciliationService.getMetrics();

    // Determine overall health status
    const hasOpenCircuitBreaker = errorStats.circuitBreakers.some((cb) => cb.state === "open");
    const isHealthy =
      rssMemoryPercentage < 90 &&
      metrics.activeConnections >= 0 &&
      (webSocketStats.failedConnections || 0) / Math.max(webSocketStats.totalConnections || 1, 1) < 0.5 &&
      !hasOpenCircuitBreaker;

    const healthData = {
      status: isHealthy ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),

      // Enhanced memory metrics (critical for Cloud Run)
      memory: {
        heap: {
          used: memUsage.heapUsed,
          total: memUsage.heapTotal,
          percentage: (memUsage.heapUsed / memUsage.heapTotal) * 100,
        },
        rss: {
          used: memUsage.rss,
          containerLimit: containerMemLimit,
          percentage: rssMemoryPercentage,
        },
        external: memUsage.external,
        arrayBuffers: memUsage.arrayBuffers,
      },

      // CPU metrics
      cpu: {
        user: cpuUsage.user,
        system: cpuUsage.system,
      },

      // Connection metrics
      connections: {
        total: metrics.totalConnections,
        active: metrics.activeConnections,
        pending: metrics.pendingConnections,
        memoryUsage: metrics.memoryUsage,
      },

      // WebSocket health (critical for WhatsApp connections)
      websocket: {
        total: webSocketStats.totalConnections || 0,
        healthy: webSocketStats.healthyConnections || 0,
        degraded: webSocketStats.degradedConnections || 0,
        failed: webSocketStats.failedConnections || 0,
        averageFailures: webSocketStats.averageFailures || 0,
      },

      // Instance coordination metrics (for multi-instance deployment)
      instance: {
        id: coordinationMetrics.instanceId,
        ownedSessions: coordinationMetrics.ownedSessions,
        totalInstances: coordinationMetrics.totalInstances,
        healthyInstances: coordinationMetrics.healthyInstances,
        config: coordinationMetrics.config,
      },

      // Error handling statistics
      errors: {
        totalCircuitBreakers: errorStats.circuitBreakers.length,
        openCircuitBreakers: errorStats.circuitBreakers.filter((cb) => cb.state === "open").length,
        totalErrorTypes: errorStats.errorStats.length,
        recentErrors: errorStats.errorStats.filter(
          (e) => new Date().getTime() - new Date(e.lastOccurrence).getTime() < 300000 // 5 minutes
        ).length,
        circuitBreakers: errorStats.circuitBreakers,
        errorStats: errorStats.errorStats,
      },

      // Proxy metrics
      proxy: metrics.proxyMetrics,

      // Reconciliation metrics (status sync monitoring)
      reconciliation: {
        totalChecks: reconciliationMetrics.totalChecks,
        desyncDetected: reconciliationMetrics.desyncDetected,
        desyncFixed: reconciliationMetrics.desyncFixed,
        desyncFailed: reconciliationMetrics.desyncFailed,
        lastCheckTime: reconciliationMetrics.lastCheckTime,
        recentDesyncs: reconciliationMetrics.desyncs.slice(-10), // Last 10 desyncs
        successRate: reconciliationMetrics.desyncDetected > 0 ? (reconciliationMetrics.desyncFixed / reconciliationMetrics.desyncDetected) * 100 : 100,
      },

      // Environment info
      environment: {
        nodeEnv: process.env.NODE_ENV,
        cloudRun: !!process.env.K_SERVICE,
        maxConnections: process.env.MAX_CONNECTIONS,
        memoryThreshold: process.env.MEMORY_THRESHOLD,
        sessionStorageType: process.env.SESSION_STORAGE_TYPE,
      },
    };

    // Set appropriate HTTP status based on health
    res.status(isHealthy ? 200 : 503).json(healthData);
  } catch (error) {
    logger.error({ error }, "Error in health check endpoint");
    res.status(500).json({
      status: "error",
      timestamp: new Date().toISOString(),
      error: "Health check failed",
    });
  }
});

// Status verification and reconciliation endpoint
// Allows manual triggering of reconciliation and checking for desyncs
app.get("/status-check", async (req: Request, res: Response) => {
  try {
    const triggerReconciliation = req.query.reconcile === "true";

    // Get current reconciliation metrics
    const beforeMetrics = statusReconciliationService.getMetrics();

    // Optionally trigger manual reconciliation
    if (triggerReconciliation) {
      logger.info({ correlationId: req.correlationId }, "Manual reconciliation triggered via /status-check endpoint");
      await statusReconciliationService.manualReconcile();
    }

    // Get updated metrics after reconciliation
    const afterMetrics = statusReconciliationService.getMetrics();

    // Get current connection counts
    const connectionPoolMetrics = connectionPool.getMetrics();

    const response = {
      timestamp: new Date().toISOString(),
      reconciliationTriggered: triggerReconciliation,

      // Connection counts
      connections: {
        inMemory: connectionPoolMetrics.activeConnections,
        total: connectionPoolMetrics.totalConnections,
      },

      // Reconciliation statistics
      reconciliation: {
        totalChecks: afterMetrics.totalChecks,
        lastCheckTime: afterMetrics.lastCheckTime,
        desyncDetected: afterMetrics.desyncDetected,
        desyncFixed: afterMetrics.desyncFixed,
        desyncFailed: afterMetrics.desyncFailed,
        successRate: afterMetrics.desyncDetected > 0 ? (afterMetrics.desyncFixed / afterMetrics.desyncDetected) * 100 : 100,
        recentDesyncs: afterMetrics.desyncs.slice(-20), // Last 20 desyncs for analysis
      },

      // If reconciliation was triggered, show what changed
      ...(triggerReconciliation && {
        reconciliationResults: {
          desyncsFoundThisRun: afterMetrics.desyncDetected - beforeMetrics.desyncDetected,
          desyncsFixedThisRun: afterMetrics.desyncFixed - beforeMetrics.desyncFixed,
          desyncsFailedThisRun: afterMetrics.desyncFailed - beforeMetrics.desyncFailed,
        },
      }),

      // Health status
      status: afterMetrics.desyncFailed === 0 || afterMetrics.desyncFailed / Math.max(afterMetrics.desyncDetected, 1) < 0.1 ? "healthy" : "degraded",

      // Instructions for manual reconciliation
      help: {
        trigger: "Add ?reconcile=true to URL to manually trigger reconciliation",
        example: `${req.protocol}://${req.get("host")}/status-check?reconcile=true`,
      },
    };

    // Return 503 if there are unresolved desyncs
    const hasUnresolvedDesyncs = afterMetrics.desyncFailed > 0;
    res.status(hasUnresolvedDesyncs ? 503 : 200).json(response);
  } catch (error) {
    logger.error({ error }, "Error in status-check endpoint");
    res.status(500).json({
      status: "error",
      timestamp: new Date().toISOString(),
      error: "Status check failed",
    });
  }
});

// Liveness probe for Kubernetes/Cloud Run
app.get("/liveness", (_req: Request, res: Response) => {
  res.status(200).send("OK");
});

// Readiness probe for Kubernetes/Cloud Run
app.get("/readiness", (_req: Request, res: Response) => {
  // Check if service is ready to accept traffic
  if (connectionPool.getMetrics().memoryUsage < 0.9) {
    res.status(200).send("Ready");
  } else {
    res.status(503).send("Not Ready - High memory usage");
  }
});

// API Routes
app.use("/api", createApiRoutes(connectionPool, sessionManager, proxyManager, connectionStateManager, reconnectionService));

// WebSocket handlers
createWebSocketHandlers(io, connectionPool, sessionManager);

// Enhanced error handling middleware with detailed logging
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  const errorId = `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Comprehensive error logging
  logger.error(
    {
      errorId,
      correlationId: req.correlationId,
      error: err.message,
      errorName: err.name,
      stack: err.stack,
      url: req.url,
      method: req.method,
      headers: req.headers,
      query: req.query,
      userId: (req as any).user?.userId,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      timestamp: new Date().toISOString(),
    },
    "Unhandled error in request"
  );

  // Send appropriate error response
  const statusCode = (err as any).statusCode || 500;
  res.status(statusCode).json({
    error: statusCode === 500 ? "Internal Server Error" : err.message,
    errorId,
    correlationId: req.correlationId,
    message: process.env.NODE_ENV === "development" ? err.message : undefined,
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
  });
});

// Enhanced 404 handler with logging
app.use((req: Request, res: Response) => {
  logger.warn(
    {
      correlationId: req.correlationId,
      method: req.method,
      path: req.path,
      url: req.url,
      query: req.query,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      timestamp: new Date().toISOString(),
    },
    "Route not found"
  );

  res.status(404).json({
    error: "Not Found",
    path: req.path,
    correlationId: req.correlationId,
  });
});

// Connection pool event handlers

connectionPool.on("health-check", async (metrics) => {
  logger.debug({ metrics }, "Health check completed");
});

// Graceful shutdown
const gracefulShutdown = async (signal: string) => {
  logger.info(`Received ${signal}, starting graceful shutdown`);

  // Stop accepting new connections
  server.close(() => {
    logger.info("HTTP server closed");
  });

  // Close WebSocket connections
  io.close(() => {
    logger.info("WebSocket server closed");
  });

  // Stop status reconciliation service
  statusReconciliationService.stop();

  // Mark sessions for graceful shutdown
  if (sessionRecoveryService) {
    await sessionRecoveryService.shutdown();
  }

  // Shutdown instance coordinator to release session ownership
  await instanceCoordinator.shutdown();

  // Shutdown connection pool with session preservation for deployments
  await connectionPool.shutdown(true); // preserveSessions = true

  // Exit process
  process.exit(0);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Start server
const PORT = process.env.PORT || 8090;
server.listen(PORT, async () => {
  logger.info(
    {
      port: PORT,
      env: process.env.NODE_ENV || "development",
      maxConnections: process.env.MAX_CONNECTIONS || 50,
      instanceUrl: process.env.INSTANCE_URL || `http://localhost:${PORT}`,
    },
    "WhatsApp Web service started"
  );

  // Recover previous connections after a short delay to ensure all services are ready
  setTimeout(async () => {
    logger.info("Initiating connection recovery after server restart");
    try {
      // Start instance coordinator first for session ownership management
      await instanceCoordinator.start();

      if (sessionRecoveryService) {
        // Use new comprehensive recovery service
        await sessionRecoveryService.cleanupOldInstances();
        await sessionRecoveryService.recoverActiveSessions();
      } else {
        // Fallback to basic recovery for non-ISP setups
        if (connectionPool.initializeRecovery) {
          await connectionPool.initializeRecovery();
        }
      }

      // Start status reconciliation service after recovery completes
      // This ensures initial state is synced before starting periodic checks
      logger.info("Starting status reconciliation service");
      statusReconciliationService.start();
    } catch (error) {
      logger.error({ error }, "Failed to recover connections on startup");
    }
  }, 20000); // 20 second delay to allow old instance shutdown
});
