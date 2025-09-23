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
exports.MessageQueueService = void 0;
const bull_1 = __importDefault(require("bull"));
const pino_1 = __importDefault(require("pino"));
const admin = __importStar(require("firebase-admin"));
class MessageQueueService {
    queue;
    deadLetterQueue;
    logger = (0, pino_1.default)({ name: "MessageQueue" });
    firestore;
    connectionPool; // Will be injected
    queueConfig = {
        redis: {
            host: process.env.REDIS_HOST || "localhost",
            port: parseInt(process.env.REDIS_PORT || "6379"),
            password: process.env.REDIS_PASSWORD,
            db: parseInt(process.env.REDIS_DB || "0"),
            retryStrategy: (times) => {
                // Exponential backoff for Redis connection
                return Math.min(times * 1000, 30000);
            }
        }
    };
    jobOptions = {
        attempts: 5,
        backoff: {
            type: "exponential",
            delay: 2000 // Start with 2 seconds
        },
        removeOnComplete: 100, // Keep last 100 completed jobs
        removeOnFail: false // Keep failed jobs for analysis
    };
    constructor(firestore) {
        this.firestore = firestore;
        // Initialize main queue
        this.queue = new bull_1.default("whatsapp-messages", {
            redis: this.queueConfig.redis,
            defaultJobOptions: this.jobOptions
        });
        // Initialize dead letter queue for failed messages
        this.deadLetterQueue = new bull_1.default("whatsapp-messages-dlq", {
            redis: this.queueConfig.redis
        });
        this.setupQueueHandlers();
        this.setupMetrics();
        this.logger.info("Message queue service initialized");
    }
    /**
     * Set the connection pool (circular dependency resolution)
     */
    setConnectionPool(connectionPool) {
        this.connectionPool = connectionPool;
        this.startProcessing();
    }
    /**
     * Add a message to the queue
     */
    async queueMessage(message) {
        try {
            // Set priority based on metadata
            const priority = this.calculatePriority(message);
            const job = await this.queue.add("send-message", message, {
                priority,
                delay: this.calculateDelay(message),
                attempts: message.maxRetries || 5
            });
            this.logger.info({
                jobId: job.id,
                userId: message.userId,
                toNumber: message.toNumber
            }, "Message queued successfully");
            // Store job reference in Firestore for tracking
            await this.storeJobReference(job.id, message);
            return job.id;
        }
        catch (error) {
            this.logger.error({ error, message }, "Failed to queue message");
            throw error;
        }
    }
    /**
     * Process messages from the queue
     */
    startProcessing() {
        this.queue.process("send-message", 5, async (job) => {
            const { userId, phoneNumber, toNumber, content } = job.data;
            this.logger.info({
                jobId: job.id,
                attempt: job.attemptsMade + 1,
                maxAttempts: job.opts.attempts
            }, "Processing message job");
            try {
                // Check if connection is available
                const connection = this.connectionPool.getConnection(userId, phoneNumber);
                if (!connection || connection.state.connection !== "open") {
                    // Connection not ready, retry later
                    throw new Error("Connection not available");
                }
                // Send message
                const messageKey = await this.connectionPool.sendMessage(userId, phoneNumber, toNumber, content);
                if (!messageKey) {
                    throw new Error("Failed to send message - no message key returned");
                }
                // Update job progress
                await job.progress(100);
                // Store success in Firestore
                await this.updateJobStatus(job.id, "completed", messageKey);
                return {
                    success: true,
                    messageKey,
                    timestamp: new Date()
                };
            }
            catch (error) {
                this.logger.error({
                    jobId: job.id,
                    error: error.message,
                    attempt: job.attemptsMade + 1
                }, "Failed to send message");
                // Update job status
                await this.updateJobStatus(job.id, "failed", null, error.message);
                // If it's the last attempt, move to dead letter queue
                if (job.attemptsMade + 1 >= (job.opts.attempts || 5)) {
                    await this.moveToDeadLetter(job);
                }
                throw error;
            }
        });
    }
    /**
     * Setup queue event handlers
     */
    setupQueueHandlers() {
        // Completed jobs
        this.queue.on("completed", (job, result) => {
            this.logger.info({
                jobId: job.id,
                result
            }, "Message sent successfully");
        });
        // Failed jobs
        this.queue.on("failed", (job, error) => {
            this.logger.error({
                jobId: job.id,
                error: error.message,
                attempts: job.attemptsMade
            }, "Message job failed");
        });
        // Stalled jobs (crashed during processing)
        this.queue.on("stalled", (job) => {
            this.logger.warn({
                jobId: job.id
            }, "Message job stalled - will retry");
        });
        // Global error handler
        this.queue.on("error", (error) => {
            this.logger.error({ error }, "Queue error");
        });
        // Redis connection events
        this.queue.on("ready", () => {
            this.logger.info("Queue ready and connected to Redis");
        });
        this.queue.on("cleaned", (jobs, type) => {
            this.logger.debug({
                count: jobs.length,
                type
            }, "Cleaned old jobs");
        });
    }
    /**
     * Move failed message to dead letter queue
     */
    async moveToDeadLetter(job) {
        try {
            const dlqJob = await this.deadLetterQueue.add("failed-message", {
                ...job.data,
                originalJobId: job.id,
                failedAt: new Date(),
                failReason: job.failedReason
            });
            this.logger.warn({
                originalJobId: job.id,
                dlqJobId: dlqJob.id
            }, "Message moved to dead letter queue");
            // Notify admins or trigger alert
            await this.notifyFailure(job);
        }
        catch (error) {
            this.logger.error({ error, jobId: job.id }, "Failed to move to DLQ");
        }
    }
    /**
     * Calculate message priority
     */
    calculatePriority(message) {
        // Higher number = higher priority
        if (message.metadata?.priority === "high")
            return 10;
        if (message.metadata?.priority === "low")
            return 1;
        // Campaign messages get medium-high priority
        if (message.metadata?.campaignId)
            return 7;
        // Template messages get medium priority
        if (message.metadata?.templateId)
            return 5;
        // Default priority
        return 3;
    }
    /**
     * Calculate delay for rate limiting
     */
    calculateDelay(message) {
        // Implement rate limiting logic
        // For now, no delay for first message
        if (!message.retryCount || message.retryCount === 0) {
            return 0;
        }
        // Exponential backoff for retries
        return Math.min(Math.pow(2, message.retryCount) * 1000, 60000);
    }
    /**
     * Store job reference in Firestore
     */
    async storeJobReference(jobId, message) {
        try {
            const jobRef = this.firestore
                .collection("message_queue_jobs")
                .doc(jobId);
            await jobRef.set({
                jobId,
                userId: message.userId,
                phoneNumber: message.phoneNumber,
                toNumber: message.toNumber,
                status: "pending",
                createdAt: admin.firestore.Timestamp.now(),
                metadata: message.metadata || {}
            });
        }
        catch (error) {
            this.logger.error({ error, jobId }, "Failed to store job reference");
        }
    }
    /**
     * Update job status in Firestore
     */
    async updateJobStatus(jobId, status, messageKey, error) {
        try {
            const jobRef = this.firestore
                .collection("message_queue_jobs")
                .doc(jobId);
            const update = {
                status,
                updatedAt: admin.firestore.Timestamp.now()
            };
            if (messageKey) {
                update.messageKey = messageKey;
                update.completedAt = admin.firestore.Timestamp.now();
            }
            if (error) {
                update.error = error;
                update.failedAt = admin.firestore.Timestamp.now();
            }
            await jobRef.update(update);
        }
        catch (error) {
            this.logger.error({ error, jobId }, "Failed to update job status");
        }
    }
    /**
     * Notify about failed messages
     */
    async notifyFailure(job) {
        try {
            // Store failure in Firestore for admin dashboard
            await this.firestore.collection("message_failures").add({
                jobId: job.id,
                userId: job.data.userId,
                phoneNumber: job.data.phoneNumber,
                toNumber: job.data.toNumber,
                failedAt: admin.firestore.Timestamp.now(),
                reason: job.failedReason,
                attempts: job.attemptsMade
            });
            // TODO: Send email/SMS notification to admin
        }
        catch (error) {
            this.logger.error({ error, jobId: job.id }, "Failed to notify about failure");
        }
    }
    /**
     * Setup metrics collection
     */
    setupMetrics() {
        setInterval(async () => {
            try {
                const metrics = await this.getQueueMetrics();
                // Store metrics in Firestore
                await this.firestore.collection("queue_metrics").add({
                    timestamp: admin.firestore.Timestamp.now(),
                    ...metrics
                });
                this.logger.debug({ metrics }, "Queue metrics collected");
            }
            catch (error) {
                this.logger.error({ error }, "Failed to collect metrics");
            }
        }, 60000); // Every minute
    }
    /**
     * Get queue metrics
     */
    async getQueueMetrics() {
        const [waiting, active, completed, failed, delayed, paused] = await Promise.all([
            this.queue.getWaitingCount(),
            this.queue.getActiveCount(),
            this.queue.getCompletedCount(),
            this.queue.getFailedCount(),
            this.queue.getDelayedCount(),
            this.queue.getPausedCount()
        ]);
        const dlqCount = await this.deadLetterQueue.getWaitingCount();
        return {
            waiting,
            active,
            completed,
            failed,
            delayed,
            paused,
            deadLetter: dlqCount,
            total: waiting + active + delayed
        };
    }
    /**
     * Retry failed messages from DLQ
     */
    async retryDeadLetterMessages(limit = 10) {
        try {
            const jobs = await this.deadLetterQueue.getWaiting(0, limit);
            let retried = 0;
            for (const job of jobs) {
                const data = job.data;
                // Reset retry count
                data.retryCount = 0;
                // Re-queue the message
                await this.queueMessage(data);
                // Remove from DLQ
                await job.remove();
                retried++;
            }
            this.logger.info({ count: retried }, "Retried messages from DLQ");
            return retried;
        }
        catch (error) {
            this.logger.error({ error }, "Failed to retry DLQ messages");
            return 0;
        }
    }
    /**
     * Pause message processing
     */
    async pause() {
        await this.queue.pause();
        this.logger.info("Message queue paused");
    }
    /**
     * Resume message processing
     */
    async resume() {
        await this.queue.resume();
        this.logger.info("Message queue resumed");
    }
    /**
     * Graceful shutdown
     */
    async shutdown() {
        this.logger.info("Shutting down message queue");
        // Stop accepting new jobs
        await this.queue.pause();
        // Wait for active jobs to complete (max 30 seconds)
        const timeout = setTimeout(() => {
            this.logger.warn("Timeout waiting for jobs to complete");
        }, 30000);
        await this.queue.whenCurrentJobsFinished();
        clearTimeout(timeout);
        // Close queues
        await this.queue.close();
        await this.deadLetterQueue.close();
        this.logger.info("Message queue shutdown complete");
    }
    /**
     * Get job status by ID
     */
    async getJobStatus(jobId) {
        try {
            const job = await this.queue.getJob(jobId);
            if (!job) {
                // Check dead letter queue
                const dlqJob = await this.deadLetterQueue.getJob(jobId);
                if (dlqJob) {
                    return {
                        id: dlqJob.id,
                        status: "failed",
                        data: dlqJob.data,
                        failedReason: dlqJob.failedReason,
                        attemptsMade: dlqJob.attemptsMade
                    };
                }
                return null;
            }
            const state = await job.getState();
            return {
                id: job.id,
                status: state,
                data: job.data,
                progress: job.progress(),
                attemptsMade: job.attemptsMade,
                createdAt: new Date(job.timestamp),
                processedAt: job.processedOn ? new Date(job.processedOn) : null,
                completedAt: job.finishedOn ? new Date(job.finishedOn) : null
            };
        }
        catch (error) {
            this.logger.error({ error, jobId }, "Failed to get job status");
            return null;
        }
    }
    /**
     * Clean old jobs
     */
    async cleanOldJobs(olderThan = 7 * 24 * 60 * 60 * 1000) {
        const grace = 5000; // 5 seconds grace period
        const [completed, failed] = await Promise.all([
            this.queue.clean(grace, "completed", olderThan),
            this.queue.clean(grace, "failed", olderThan)
        ]);
        this.logger.info({
            completed: completed.length,
            failed: failed.length
        }, "Cleaned old jobs");
        return completed.length + failed.length;
    }
}
exports.MessageQueueService = MessageQueueService;
//# sourceMappingURL=messageQueue.js.map