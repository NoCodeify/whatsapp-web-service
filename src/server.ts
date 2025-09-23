import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import { createServer } from "http";
import { Server as SocketServer } from "socket.io";
import pino from "pino";
import { Firestore } from "@google-cloud/firestore";
import { PubSub } from "@google-cloud/pubsub";
import * as dotenv from "dotenv";

// Core modules
import { ProxyManager } from "./core/ProxyManager";
import { SessionManager } from "./core/SessionManager";
import { ConnectionPool } from "./core/ConnectionPool";
import { ConnectionStateManager } from "./services/connectionStateManager";
import { DynamicProxyService } from "./services/DynamicProxyService";
import { SessionRecoveryService } from "./services/SessionRecoveryService";
import { ReconnectionService } from "./services/ReconnectionService";
import { AutoScalingService } from "./scaling/AutoScalingService";

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
      ignore: "pid,hostname"
    }
  }
});

// Initialize services
const firestore = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT
});

const pubsub = new PubSub({
  projectId: process.env.GOOGLE_CLOUD_PROJECT
});

// Initialize recovery services (only if proxy type is ISP)
let dynamicProxyService: DynamicProxyService | undefined;
let sessionRecoveryService: SessionRecoveryService | undefined;

if (process.env.BRIGHT_DATA_PROXY_TYPE === "isp") {
  dynamicProxyService = new DynamicProxyService();
  sessionRecoveryService = new SessionRecoveryService(
    firestore,
    dynamicProxyService,
    `instance_${process.env.HOSTNAME || 'unknown'}_${Date.now()}`
  );
}

// Initialize core components with proper dependencies
const proxyManager = new ProxyManager(firestore, dynamicProxyService);
const sessionManager = new SessionManager(proxyManager, firestore);
const connectionStateManager = new ConnectionStateManager(firestore);

// Initialize reconnection service
const reconnectionService = new ReconnectionService(
  sessionManager,
  undefined as any, // Will be set after connectionPool is created
  firestore
);

const connectionPool = new ConnectionPool(
  proxyManager,
  sessionManager,
  firestore,
  pubsub,
  connectionStateManager
);

// Set connection pool reference for recovery service
if (sessionRecoveryService) {
  sessionRecoveryService.setConnectionPool(connectionPool);
}

// Set connection pool reference for reconnection service
(reconnectionService as any).connectionPool = connectionPool;

// Initialize autoscaling service
const autoScalingService = new AutoScalingService(firestore);

// Create Express app
const app = express();
const server = createServer(app);
const io = new SocketServer(server, {
  cors: {
    origin: process.env.CORS_ORIGIN === '*' ? true : (process.env.CORS_ORIGIN?.split(",") || ["http://localhost:3000"]),
    credentials: true,
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(compression());

// Configure CORS with proper options
const corsOptions = {
  origin: (origin: any, callback: any) => {
    // Allow requests with no origin (like mobile apps, Postman)
    if (!origin) return callback(null, true);
    
    // In development, allow all origins if CORS_ORIGIN is '*'
    if (process.env.CORS_ORIGIN === '*') {
      return callback(null, true);
    }
    
    // Otherwise, check against allowed origins
    const allowedOrigins = process.env.CORS_ORIGIN?.split(",") || ["http://localhost:3000"];
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-user-id'],
  preflightContinue: false,
  optionsSuccessStatus: 204,
  maxAge: 86400 // Cache preflight response for 24 hours
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
  req.correlationId = (req.headers["x-correlation-id"] as string) || 
                      `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  req.startTime = Date.now();
  
  // Set correlation ID in response headers for client tracking
  res.setHeader("x-correlation-id", req.correlationId);
  
  next();
});

// Enhanced request logging with correlation ID
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = req.startTime || Date.now();
  
  // Log request received
  logger.info({
    correlationId: req.correlationId,
    method: req.method,
    url: req.url,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    contentLength: req.headers["content-length"]
  }, "Request received");
  
  res.on("finish", () => {
    const duration = Date.now() - start;
    
    // Log request completed with metrics
    logger.info({
      correlationId: req.correlationId,
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration,
      durationMs: duration,
      contentLength: res.get("content-length"),
      // Add severity based on status code
      ...(res.statusCode >= 500 && { severity: "ERROR" }),
      ...(res.statusCode >= 400 && res.statusCode < 500 && { severity: "WARNING" })
    }, `Request completed: ${res.statusCode >= 400 ? "failed" : "success"}`);
    
    // Log slow requests as warnings
    if (duration > 5000) {
      logger.warn({
        correlationId: req.correlationId,
        method: req.method,
        url: req.url,
        duration,
        threshold: 5000
      }, "Slow request detected");
    }
  });
  
  next();
});

// Health check endpoint
app.get("/health", (_req: Request, res: Response) => {
  const metrics = connectionPool.getMetrics();
  
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: {
      used: process.memoryUsage().heapUsed,
      total: process.memoryUsage().heapTotal,
      percentage: (process.memoryUsage().heapUsed / process.memoryUsage().heapTotal) * 100
    },
    connections: {
      total: metrics.totalConnections,
      active: metrics.activeConnections,
      pending: metrics.pendingConnections
    },
    proxy: metrics.proxyMetrics
  });
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
  logger.error({
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
    timestamp: new Date().toISOString()
  }, "Unhandled error in request");
  
  // Send appropriate error response
  const statusCode = (err as any).statusCode || 500;
  res.status(statusCode).json({
    error: statusCode === 500 ? "Internal Server Error" : err.message,
    errorId,
    correlationId: req.correlationId,
    message: process.env.NODE_ENV === "development" ? err.message : undefined,
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined
  });
});

// Enhanced 404 handler with logging
app.use((req: Request, res: Response) => {
  logger.warn({
    correlationId: req.correlationId,
    method: req.method,
    path: req.path,
    url: req.url,
    query: req.query,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    timestamp: new Date().toISOString()
  }, "Route not found");
  
  res.status(404).json({
    error: "Not Found",
    path: req.path,
    correlationId: req.correlationId
  });
});

// Connection pool event handlers
connectionPool.on("capacity-reached", async (data) => {
  logger.warn("Connection pool capacity reached, triggering autoscaling evaluation");

  try {
    await autoScalingService.evaluateScaling({
      connectionCount: data?.connectionCount || connectionPool.getMetrics().activeConnections,
      maxConnections: parseInt(process.env.MAX_CONNECTIONS || "50"),
      memoryUsage: data?.memoryUsage || connectionPool.getMetrics().memoryUsage,
      memoryThreshold: parseFloat(process.env.MEMORY_THRESHOLD || "0.8"),
      instanceId: process.env.HOSTNAME || `instance_${Date.now()}`,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error({ error }, "Failed to trigger autoscaling on capacity reached");
  }
});

connectionPool.on("memory-threshold-exceeded", async (data) => {
  logger.warn("Memory threshold exceeded, triggering autoscaling evaluation");

  try {
    await autoScalingService.evaluateScaling({
      connectionCount: data?.connectionCount || connectionPool.getMetrics().activeConnections,
      maxConnections: parseInt(process.env.MAX_CONNECTIONS || "50"),
      memoryUsage: data?.memoryUsage || connectionPool.getMetrics().memoryUsage,
      memoryThreshold: parseFloat(process.env.MEMORY_THRESHOLD || "0.8"),
      instanceId: process.env.HOSTNAME || `instance_${Date.now()}`,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error({ error }, "Failed to trigger autoscaling on memory threshold exceeded");
  }
});

connectionPool.on("health-check", async (metrics) => {
  logger.debug({ metrics }, "Health check completed");

  // Also evaluate scaling on regular health checks
  try {
    await autoScalingService.evaluateScaling({
      connectionCount: metrics.activeConnections,
      maxConnections: parseInt(process.env.MAX_CONNECTIONS || "50"),
      memoryUsage: metrics.memoryUsage,
      memoryThreshold: parseFloat(process.env.MEMORY_THRESHOLD || "0.8"),
      instanceId: process.env.HOSTNAME || `instance_${Date.now()}`,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.debug({ error }, "Failed to evaluate autoscaling on health check");
  }
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
  
  // Mark sessions for graceful shutdown
  if (sessionRecoveryService) {
    await sessionRecoveryService.shutdown();
  }
  
  // Shutdown connection pool
  await connectionPool.shutdown();
  
  // Exit process
  process.exit(0);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Start server
const PORT = process.env.PORT || 8090;
server.listen(PORT, async () => {
  logger.info({
    port: PORT,
    env: process.env.NODE_ENV || "development",
    maxConnections: process.env.MAX_CONNECTIONS || 50,
    instanceUrl: process.env.INSTANCE_URL || `http://localhost:${PORT}`
  }, "WhatsApp Web service started");
  
  // Recover previous connections after a short delay to ensure all services are ready
  setTimeout(async () => {
    logger.info("Initiating connection recovery after server restart");
    try {
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
    } catch (error) {
      logger.error({ error }, "Failed to recover connections on startup");
    }
  }, 3000); // 3 second delay
});