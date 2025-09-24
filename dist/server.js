"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const compression_1 = __importDefault(require("compression"));
const http_1 = require("http");
const socket_io_1 = require("socket.io");
const pino_1 = __importDefault(require("pino"));
const firestore_1 = require("@google-cloud/firestore");
const pubsub_1 = require("@google-cloud/pubsub");
// import { Storage } from "@google-cloud/storage"; // Commented out - not currently used
const dotenv = __importStar(require("dotenv"));
// Core modules
const ProxyManager_1 = require("./core/ProxyManager");
const SessionManager_1 = require("./core/SessionManager");
const ConnectionPool_1 = require("./core/ConnectionPool");
const connectionStateManager_1 = require("./services/connectionStateManager");
const DynamicProxyService_1 = require("./services/DynamicProxyService");
const SessionRecoveryService_1 = require("./services/SessionRecoveryService");
const ReconnectionService_1 = require("./services/ReconnectionService");
const AutoScalingService_1 = require("./scaling/AutoScalingService");
const InstanceCoordinator_1 = require("./services/InstanceCoordinator");
const CloudRunWebSocketManager_1 = require("./services/CloudRunWebSocketManager");
const ErrorHandler_1 = require("./services/ErrorHandler");
const MemoryLeakPrevention_1 = require("./services/MemoryLeakPrevention");
// import { CloudRunSessionOptimizer } from "./services/CloudRunSessionOptimizer"; // Commented out - not currently used
// API routes
const routes_1 = require("./api/routes");
const websocket_1 = require("./api/websocket");
// Load environment variables
dotenv.config();
// Initialize logger
const logger = (0, pino_1.default)({
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
const firestore = new firestore_1.Firestore({
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
});
const pubsub = new pubsub_1.PubSub({
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
});
// const storage = new Storage({
//   projectId: process.env.GOOGLE_CLOUD_PROJECT,
// }); // Commented out - not currently used
// Initialize recovery services (only if proxy type is ISP)
let dynamicProxyService;
let sessionRecoveryService;
// Always initialize ISP proxy services since we hardcode to ISP
dynamicProxyService = new DynamicProxyService_1.DynamicProxyService();
sessionRecoveryService = new SessionRecoveryService_1.SessionRecoveryService(firestore, dynamicProxyService, `instance_${process.env.HOSTNAME || "unknown"}_${Date.now()}`);
// Initialize core components with proper dependencies
const proxyManager = new ProxyManager_1.ProxyManager(firestore, dynamicProxyService);
const sessionManager = new SessionManager_1.SessionManager(proxyManager, firestore);
const connectionStateManager = new connectionStateManager_1.ConnectionStateManager(firestore);
// Initialize reconnection service
const reconnectionService = new ReconnectionService_1.ReconnectionService(sessionManager, undefined, // Will be set after connectionPool is created
firestore);
const connectionPool = new ConnectionPool_1.ConnectionPool(proxyManager, sessionManager, firestore, pubsub, connectionStateManager);
// Set connection pool reference for recovery service
if (sessionRecoveryService) {
    sessionRecoveryService.setConnectionPool(connectionPool);
}
// Set connection pool reference for reconnection service
reconnectionService.connectionPool = connectionPool;
// Initialize autoscaling service
const autoScalingService = new AutoScalingService_1.AutoScalingService(firestore);
// Initialize Cloud Run optimization services
const instanceCoordinator = new InstanceCoordinator_1.InstanceCoordinator(firestore);
const webSocketManager = new CloudRunWebSocketManager_1.CloudRunWebSocketManager();
const errorHandler = new ErrorHandler_1.ErrorHandler();
const memoryLeakPrevention = new MemoryLeakPrevention_1.MemoryLeakPrevention();
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
const app = (0, express_1.default)();
const server = (0, http_1.createServer)(app);
const io = new socket_io_1.Server(server, {
    cors: {
        origin: process.env.CORS_ORIGIN === "*"
            ? true
            : process.env.CORS_ORIGIN?.split(",") || ["http://localhost:3000"],
        credentials: true,
        methods: ["GET", "POST"],
    },
});
// Middleware
app.use((0, helmet_1.default)({
    crossOriginResourcePolicy: { policy: "cross-origin" },
}));
app.use((0, compression_1.default)());
// Configure CORS with proper options
const corsOptions = {
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps, Postman)
        if (!origin)
            return callback(null, true);
        // In development, allow all origins if CORS_ORIGIN is '*'
        if (process.env.CORS_ORIGIN === "*") {
            return callback(null, true);
        }
        // Otherwise, check against allowed origins
        const allowedOrigins = process.env.CORS_ORIGIN?.split(",") || [
            "http://localhost:3000",
        ];
        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        }
        else {
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
app.use((0, cors_1.default)(corsOptions));
app.use(express_1.default.json({ limit: "50mb" }));
app.use(express_1.default.urlencoded({ extended: true, limit: "50mb" }));
// Correlation ID middleware - essential for request tracing
app.use((req, res, next) => {
    // Generate or use existing correlation ID
    req.correlationId =
        req.headers["x-correlation-id"] ||
            `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    req.startTime = Date.now();
    // Set correlation ID in response headers for client tracking
    res.setHeader("x-correlation-id", req.correlationId);
    next();
});
// Enhanced request logging with correlation ID
app.use((req, res, next) => {
    const start = req.startTime || Date.now();
    // Log request received
    logger.info({
        correlationId: req.correlationId,
        method: req.method,
        url: req.url,
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        contentLength: req.headers["content-length"],
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
            ...(res.statusCode >= 400 &&
                res.statusCode < 500 && { severity: "WARNING" }),
        }, `Request completed: ${res.statusCode >= 400 ? "failed" : "success"}`);
        // Log slow requests as warnings
        if (duration > 5000) {
            logger.warn({
                correlationId: req.correlationId,
                method: req.method,
                url: req.url,
                duration,
                threshold: 5000,
            }, "Slow request detected");
        }
    });
    next();
});
// Enhanced health check endpoint with comprehensive Cloud Run monitoring
app.get("/health", async (_req, res) => {
    try {
        const metrics = connectionPool.getMetrics();
        const memUsage = process.memoryUsage();
        const cpuUsage = process.cpuUsage();
        // Get container memory limit (Cloud Run)
        const getContainerMemoryLimit = () => {
            try {
                const fs = require("fs");
                const memLimit = fs.readFileSync("/sys/fs/cgroup/memory/memory.limit_in_bytes", "utf8");
                return parseInt(memLimit.trim());
            }
            catch {
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
        // Get memory leak prevention metrics
        const memoryLeakStats = memoryLeakPrevention.getStats();
        // Determine overall health status
        const hasOpenCircuitBreaker = errorStats.circuitBreakers.some(cb => cb.state === "open");
        const isHealthy = rssMemoryPercentage < 90 &&
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
                openCircuitBreakers: errorStats.circuitBreakers.filter(cb => cb.state === "open").length,
                totalErrorTypes: errorStats.errorStats.length,
                recentErrors: errorStats.errorStats.filter(e => (new Date().getTime() - new Date(e.lastOccurrence).getTime()) < 300000 // 5 minutes
                ).length,
                circuitBreakers: errorStats.circuitBreakers,
                errorStats: errorStats.errorStats,
            },
            // Memory leak prevention metrics
            memoryLeak: {
                memory: memoryLeakStats.memory,
                tracking: memoryLeakStats.tracking,
                config: memoryLeakStats.config,
            },
            // Proxy metrics
            proxy: metrics.proxyMetrics,
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
    }
    catch (error) {
        logger.error({ error }, "Error in health check endpoint");
        res.status(500).json({
            status: "error",
            timestamp: new Date().toISOString(),
            error: "Health check failed",
        });
    }
});
// Liveness probe for Kubernetes/Cloud Run
app.get("/liveness", (_req, res) => {
    res.status(200).send("OK");
});
// Readiness probe for Kubernetes/Cloud Run
app.get("/readiness", (_req, res) => {
    // Check if service is ready to accept traffic
    if (connectionPool.getMetrics().memoryUsage < 0.9) {
        res.status(200).send("Ready");
    }
    else {
        res.status(503).send("Not Ready - High memory usage");
    }
});
// API Routes
app.use("/api", (0, routes_1.createApiRoutes)(connectionPool, sessionManager, proxyManager, connectionStateManager, reconnectionService));
// WebSocket handlers
(0, websocket_1.createWebSocketHandlers)(io, connectionPool, sessionManager);
// Enhanced error handling middleware with detailed logging
app.use((err, req, res, _next) => {
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
        userId: req.user?.userId,
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        timestamp: new Date().toISOString(),
    }, "Unhandled error in request");
    // Send appropriate error response
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({
        error: statusCode === 500 ? "Internal Server Error" : err.message,
        errorId,
        correlationId: req.correlationId,
        message: process.env.NODE_ENV === "development" ? err.message : undefined,
        stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
});
// Enhanced 404 handler with logging
app.use((req, res) => {
    logger.warn({
        correlationId: req.correlationId,
        method: req.method,
        path: req.path,
        url: req.url,
        query: req.query,
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        timestamp: new Date().toISOString(),
    }, "Route not found");
    res.status(404).json({
        error: "Not Found",
        path: req.path,
        correlationId: req.correlationId,
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
    }
    catch (error) {
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
    }
    catch (error) {
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
    }
    catch (error) {
        logger.debug({ error }, "Failed to evaluate autoscaling on health check");
    }
});
// Graceful shutdown
const gracefulShutdown = async (signal) => {
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
        instanceUrl: process.env.INSTANCE_URL || `http://localhost:${PORT}`,
    }, "WhatsApp Web service started");
    // Recover previous connections after a short delay to ensure all services are ready
    setTimeout(async () => {
        logger.info("Initiating connection recovery after server restart");
        try {
            if (sessionRecoveryService) {
                // Use new comprehensive recovery service
                await sessionRecoveryService.cleanupOldInstances();
                await sessionRecoveryService.recoverActiveSessions();
            }
            else {
                // Fallback to basic recovery for non-ISP setups
                if (connectionPool.initializeRecovery) {
                    await connectionPool.initializeRecovery();
                }
            }
        }
        catch (error) {
            logger.error({ error }, "Failed to recover connections on startup");
        }
    }, 3000); // 3 second delay
});
//# sourceMappingURL=server.js.map