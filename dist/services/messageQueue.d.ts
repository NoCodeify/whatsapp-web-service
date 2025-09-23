import { WAMessageContent, WAMessageKey } from "@whiskeysockets/baileys";
import { Firestore } from "@google-cloud/firestore";
export interface MessageJob {
  userId: string;
  phoneNumber: string;
  toNumber: string;
  content: WAMessageContent;
  retryCount?: number;
  maxRetries?: number;
  createdAt: Date;
  metadata?: {
    contactId?: string;
    campaignId?: string;
    templateId?: string;
    priority?: "high" | "normal" | "low";
  };
}
export interface MessageResult {
  success: boolean;
  messageKey?: WAMessageKey;
  error?: string;
  timestamp: Date;
}
export declare class MessageQueueService {
  private queue;
  private deadLetterQueue;
  private logger;
  private firestore;
  private connectionPool;
  private readonly queueConfig;
  private readonly jobOptions;
  constructor(firestore: Firestore);
  /**
   * Set the connection pool (circular dependency resolution)
   */
  setConnectionPool(connectionPool: any): void;
  /**
   * Add a message to the queue
   */
  queueMessage(message: MessageJob): Promise<string>;
  /**
   * Process messages from the queue
   */
  private startProcessing;
  /**
   * Setup queue event handlers
   */
  private setupQueueHandlers;
  /**
   * Move failed message to dead letter queue
   */
  private moveToDeadLetter;
  /**
   * Calculate message priority
   */
  private calculatePriority;
  /**
   * Calculate delay for rate limiting
   */
  private calculateDelay;
  /**
   * Store job reference in Firestore
   */
  private storeJobReference;
  /**
   * Update job status in Firestore
   */
  private updateJobStatus;
  /**
   * Notify about failed messages
   */
  private notifyFailure;
  /**
   * Setup metrics collection
   */
  private setupMetrics;
  /**
   * Get queue metrics
   */
  getQueueMetrics(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    paused: number;
    deadLetter: number;
    total: number;
  }>;
  /**
   * Retry failed messages from DLQ
   */
  retryDeadLetterMessages(limit?: number): Promise<number>;
  /**
   * Pause message processing
   */
  pause(): Promise<void>;
  /**
   * Resume message processing
   */
  resume(): Promise<void>;
  /**
   * Graceful shutdown
   */
  shutdown(): Promise<void>;
  /**
   * Get job status by ID
   */
  getJobStatus(jobId: string): Promise<any>;
  /**
   * Clean old jobs
   */
  cleanOldJobs(olderThan?: number): Promise<number>;
}
//# sourceMappingURL=messageQueue.d.ts.map
