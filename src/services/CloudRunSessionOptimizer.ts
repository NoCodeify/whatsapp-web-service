import { Storage } from "@google-cloud/storage";
import { Firestore } from "@google-cloud/firestore";
import pino from "pino";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);
const stat = promisify(fs.stat);
const readdir = promisify(fs.readdir);

export interface SessionCacheEntry {
  userId: string;
  phoneNumber: string;
  lastModified: Date;
  localPath: string;
  cloudPath: string;
  isValid: boolean;
}

export interface CloudRunSessionConfig {
  bucketName: string;
  cacheDir: string;
  maxCacheSize: number;
  maxCacheAge: number;
  retryAttempts: number;
  retryDelay: number;
  parallelUploads: number;
}

/**
 * Optimized session manager for Cloud Run
 * Implements aggressive caching and async operations for better performance
 */
export class CloudRunSessionOptimizer {
  private logger = pino({ name: "CloudRunSessionOptimizer" });
  private storage: Storage;
  private firestore: Firestore;
  private sessionCache: Map<string, SessionCacheEntry> = new Map();

  private readonly config: CloudRunSessionConfig = {
    bucketName: process.env.STORAGE_BUCKET || "whatsapp-web-sessions",
    cacheDir: process.env.SESSION_CACHE_DIR || "/tmp/session-cache",
    maxCacheSize: parseInt(process.env.MAX_CACHE_SIZE || "50"),
    maxCacheAge: parseInt(process.env.MAX_CACHE_AGE || "3600000"), // 1 hour
    retryAttempts: parseInt(process.env.SESSION_RETRY_ATTEMPTS || "3"),
    retryDelay: parseInt(process.env.SESSION_RETRY_DELAY || "1000"),
    parallelUploads: parseInt(process.env.PARALLEL_UPLOADS || "5"),
  };

  private uploadQueue: Array<() => Promise<void>> = [];
  private isProcessingQueue = false;

  constructor(storage: Storage, firestore: Firestore) {
    this.storage = storage;
    this.firestore = firestore;

    this.initializeCacheDirectory();
    this.startCacheCleanup();
    this.startUploadQueueProcessor();

    this.logger.info(this.config, "CloudRunSessionOptimizer initialized");
  }

  /**
   * Initialize cache directory
   */
  private async initializeCacheDirectory(): Promise<void> {
    try {
      await mkdir(this.config.cacheDir, { recursive: true });
      this.logger.info({ dir: this.config.cacheDir }, "Session cache directory initialized");
    } catch (error) {
      this.logger.error({ error }, "Failed to create session cache directory");
    }
  }

  /**
   * Check if session exists in Cloud Storage (with caching)
   */
  async sessionExists(userId: string, phoneNumber: string): Promise<boolean> {
    const sessionKey = this.getSessionKey(userId, phoneNumber);
    const cacheEntry = this.sessionCache.get(sessionKey);

    // Check cache first
    if (cacheEntry && this.isCacheValid(cacheEntry)) {
      return cacheEntry.isValid;
    }

    try {
      const bucket = this.storage.bucket(this.config.bucketName);
      const prefix = `sessions/${userId}/${phoneNumber}/`;
      const [files] = await bucket.getFiles({ prefix, maxResults: 1 });

      const exists = files.length > 0;

      // Update cache
      this.updateCache(userId, phoneNumber, exists);

      return exists;
    } catch (error) {
      this.logger.error(
        { userId, phoneNumber, error },
        "Failed to check session existence"
      );
      return false;
    }
  }

  /**
   * Download session from Cloud Storage with caching
   */
  async downloadSession(userId: string, phoneNumber: string, localPath: string): Promise<boolean> {
    const sessionKey = this.getSessionKey(userId, phoneNumber);

    try {
      // Create local directory
      await mkdir(localPath, { recursive: true });

      const bucket = this.storage.bucket(this.config.bucketName);
      const prefix = `sessions/${userId}/${phoneNumber}/`;

      const [files] = await bucket.getFiles({ prefix });

      if (files.length === 0) {
        this.logger.warn({ userId, phoneNumber }, "No session files found in Cloud Storage");
        return false;
      }

      // Download files in parallel
      const downloadPromises = files.map(async (file) => {
        const fileName = path.basename(file.name);
        const localFilePath = path.join(localPath, fileName);

        try {
          await file.download({ destination: localFilePath });
          this.logger.debug(
            { userId, phoneNumber, fileName },
            "Downloaded session file"
          );
        } catch (error) {
          this.logger.error(
            { userId, phoneNumber, fileName, error },
            "Failed to download session file"
          );
          throw error;
        }
      });

      await Promise.all(downloadPromises);

      // Update cache
      this.updateCache(userId, phoneNumber, true, localPath);

      this.logger.info(
        { userId, phoneNumber, fileCount: files.length },
        "Session downloaded from Cloud Storage"
      );

      return true;
    } catch (error) {
      this.logger.error(
        { userId, phoneNumber, error },
        "Failed to download session from Cloud Storage"
      );
      return false;
    }
  }

  /**
   * Upload session to Cloud Storage (queued)
   */
  async uploadSession(userId: string, phoneNumber: string, localPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const uploadTask = async () => {
        try {
          await this.performUpload(userId, phoneNumber, localPath);
          resolve();
        } catch (error) {
          reject(error);
        }
      };

      this.uploadQueue.push(uploadTask);
      this.processUploadQueue(); // Don't await - let it run in background
    });
  }

  /**
   * Perform the actual upload with retries
   */
  private async performUpload(userId: string, phoneNumber: string, localPath: string): Promise<void> {
    let attempt = 0;

    while (attempt < this.config.retryAttempts) {
      try {
        await this.doUpload(userId, phoneNumber, localPath);

        // Update cache on successful upload
        this.updateCache(userId, phoneNumber, true, localPath);

        return;
      } catch (error) {
        attempt++;

        if (attempt >= this.config.retryAttempts) {
          throw error;
        }

        this.logger.warn(
          { userId, phoneNumber, attempt, error },
          "Upload attempt failed, retrying"
        );

        await this.sleep(this.config.retryDelay * attempt);
      }
    }
  }

  /**
   * Execute the upload operation
   */
  private async doUpload(userId: string, phoneNumber: string, localPath: string): Promise<void> {
    try {
      const files = await readdir(localPath);
      const bucket = this.storage.bucket(this.config.bucketName);

      // Upload files in parallel
      const uploadPromises = files.map(async (fileName) => {
        const localFilePath = path.join(localPath, fileName);
        const cloudFilePath = `sessions/${userId}/${phoneNumber}/${fileName}`;

        const file = bucket.file(cloudFilePath);

        const fileData = await readFile(localFilePath);

        await file.save(fileData, {
          metadata: {
            contentType: 'application/octet-stream',
            metadata: {
              userId,
              phoneNumber,
              uploadedAt: new Date().toISOString(),
              instance: process.env.HOSTNAME || 'unknown',
            },
          },
        });

        this.logger.debug(
          { userId, phoneNumber, fileName },
          "Uploaded session file to Cloud Storage"
        );
      });

      await Promise.all(uploadPromises);

      this.logger.info(
        { userId, phoneNumber, fileCount: files.length },
        "Session uploaded to Cloud Storage"
      );

      // Update Firestore metadata
      await this.updateSessionMetadata(userId, phoneNumber, {
        lastBackup: new Date(),
        fileCount: files.length,
        storageType: 'cloud',
        instance: process.env.HOSTNAME || 'unknown',
      });

    } catch (error) {
      this.logger.error(
        { userId, phoneNumber, error },
        "Failed to upload session to Cloud Storage"
      );
      throw error;
    }
  }

  /**
   * Delete session from Cloud Storage
   */
  async deleteSession(userId: string, phoneNumber: string): Promise<void> {
    try {
      const bucket = this.storage.bucket(this.config.bucketName);
      const prefix = `sessions/${userId}/${phoneNumber}/`;

      const [files] = await bucket.getFiles({ prefix });

      if (files.length === 0) {
        this.logger.warn({ userId, phoneNumber }, "No session files to delete");
        return;
      }

      // Delete files in parallel
      const deletePromises = files.map(file => file.delete());
      await Promise.all(deletePromises);

      // Remove from cache
      const sessionKey = this.getSessionKey(userId, phoneNumber);
      this.sessionCache.delete(sessionKey);

      this.logger.info(
        { userId, phoneNumber, deletedFiles: files.length },
        "Session deleted from Cloud Storage"
      );

    } catch (error) {
      this.logger.error(
        { userId, phoneNumber, error },
        "Failed to delete session from Cloud Storage"
      );
      throw error;
    }
  }

  /**
   * Process upload queue
   */
  private async processUploadQueue(): Promise<void> {
    if (this.isProcessingQueue || this.uploadQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    try {
      while (this.uploadQueue.length > 0) {
        // Process uploads in batches
        const batch = this.uploadQueue.splice(0, this.config.parallelUploads);

        await Promise.allSettled(batch.map(task => task()));

        // Small delay between batches to prevent overwhelming Cloud Storage
        if (this.uploadQueue.length > 0) {
          await this.sleep(100);
        }
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  /**
   * Start upload queue processor
   */
  private startUploadQueueProcessor(): void {
    setInterval(() => {
      this.processUploadQueue();
    }, 5000); // Process queue every 5 seconds
  }

  /**
   * Update session metadata in Firestore
   */
  private async updateSessionMetadata(
    userId: string,
    phoneNumber: string,
    metadata: any
  ): Promise<void> {
    try {
      await this.firestore
        .collection("session_metadata")
        .doc(`${userId}-${phoneNumber}`)
        .set({
          userId,
          phoneNumber,
          ...metadata,
          updatedAt: new Date(),
        }, { merge: true });
    } catch (error) {
      this.logger.error(
        { userId, phoneNumber, error },
        "Failed to update session metadata"
      );
    }
  }

  /**
   * Cache management methods
   */
  private getSessionKey(userId: string, phoneNumber: string): string {
    return `${userId}:${phoneNumber}`;
  }

  private updateCache(
    userId: string,
    phoneNumber: string,
    isValid: boolean,
    localPath?: string
  ): void {
    const sessionKey = this.getSessionKey(userId, phoneNumber);

    this.sessionCache.set(sessionKey, {
      userId,
      phoneNumber,
      lastModified: new Date(),
      localPath: localPath || "",
      cloudPath: `sessions/${userId}/${phoneNumber}/`,
      isValid,
    });

    // Cleanup cache if it gets too large
    if (this.sessionCache.size > this.config.maxCacheSize) {
      this.cleanupCache();
    }
  }

  private isCacheValid(entry: SessionCacheEntry): boolean {
    const age = Date.now() - entry.lastModified.getTime();
    return age < this.config.maxCacheAge;
  }

  private cleanupCache(): void {
    const entries = Array.from(this.sessionCache.entries());

    // Sort by last modified date (oldest first)
    entries.sort(([, a], [, b]) => a.lastModified.getTime() - b.lastModified.getTime());

    // Remove oldest entries
    const toRemove = Math.ceil(entries.length * 0.2); // Remove 20%

    for (let i = 0; i < toRemove; i++) {
      this.sessionCache.delete(entries[i][0]);
    }

    this.logger.debug(
      { removed: toRemove, remaining: this.sessionCache.size },
      "Cleaned up session cache"
    );
  }

  /**
   * Start cache cleanup interval
   */
  private startCacheCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      let cleaned = 0;

      for (const [key, entry] of this.sessionCache.entries()) {
        if (now - entry.lastModified.getTime() > this.config.maxCacheAge) {
          this.sessionCache.delete(key);
          cleaned++;
        }
      }

      if (cleaned > 0) {
        this.logger.debug({ cleaned }, "Cleaned up expired cache entries");
      }
    }, 300000); // Every 5 minutes
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    const validEntries = Array.from(this.sessionCache.values())
      .filter(entry => this.isCacheValid(entry)).length;

    return {
      totalEntries: this.sessionCache.size,
      validEntries,
      expiredEntries: this.sessionCache.size - validEntries,
      queueSize: this.uploadQueue.length,
      isProcessingQueue: this.isProcessingQueue,
    };
  }

  /**
   * Utility methods
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Shutdown and cleanup
   */
  async shutdown(): Promise<void> {
    this.logger.info("Shutting down CloudRunSessionOptimizer");

    // Process remaining uploads
    if (this.uploadQueue.length > 0) {
      this.logger.info(
        { queueSize: this.uploadQueue.length },
        "Processing remaining uploads before shutdown"
      );
      await this.processUploadQueue();
    }

    this.sessionCache.clear();
    this.uploadQueue.length = 0;

    this.logger.info("CloudRunSessionOptimizer shutdown complete");
  }
}