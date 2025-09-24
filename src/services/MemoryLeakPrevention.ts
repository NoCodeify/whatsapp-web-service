import { WASocket } from "@whiskeysockets/baileys";
import pino from "pino";
import { EventEmitter } from "events";

export interface EventListenerTracker {
  socketId: string;
  eventName: string;
  listenerCount: number;
  addedAt: Date;
}

export interface TimerTracker {
  id: string;
  type: "timeout" | "interval";
  createdAt: Date;
  timer: NodeJS.Timeout;
}

export interface CacheStats {
  name: string;
  size: number;
  maxSize?: number;
  oldestEntry?: Date;
  newestEntry?: Date;
}

/**
 * Memory leak prevention service for WhatsApp connection pool
 * Tracks and cleans up resources that can cause memory leaks
 */
export class MemoryLeakPrevention {
  private logger = pino({ name: "MemoryLeakPrevention" });

  // Track event listeners to ensure proper cleanup
  private eventListeners: Map<string, EventListenerTracker[]> = new Map();

  // Track timers to ensure they're cleared
  private timers: Map<string, TimerTracker> = new Map();

  // Track socket references
  private socketReferences: Map<string, WeakRef<WASocket>> = new Map();

  // Memory monitoring
  private memoryCheckInterval?: NodeJS.Timeout;
  private lastMemoryCheck = 0;

  private readonly config = {
    memoryCheckInterval: parseInt(process.env.MEMORY_CHECK_INTERVAL || "30000"), // 30 seconds
    maxEventListeners: parseInt(process.env.MAX_EVENT_LISTENERS || "50"),
    maxCacheAge: parseInt(process.env.MAX_CACHE_AGE || "1800000"), // 30 minutes
    forceGCInterval: parseInt(process.env.FORCE_GC_INTERVAL || "300000"), // 5 minutes
    enableDebugLogging: process.env.MEMORY_DEBUG === "true",
  };

  constructor() {
    this.startMemoryMonitoring();
    this.logger.info(this.config, "MemoryLeakPrevention initialized");
  }

  /**
   * Register a new connection for tracking
   */
  registerConnection(connectionId: string, socket: WASocket): void {
    // Store weak reference to avoid keeping socket alive
    this.socketReferences.set(connectionId, new WeakRef(socket));

    // Initialize event listener tracking
    this.eventListeners.set(connectionId, []);

    if (this.config.enableDebugLogging) {
      this.logger.debug(
        { connectionId },
        "Registered connection for memory tracking",
      );
    }
  }

  /**
   * Track event listener addition
   */
  trackEventListener(connectionId: string, eventName: string): void {
    const listeners = this.eventListeners.get(connectionId) || [];

    const existing = listeners.find((l) => l.eventName === eventName);
    if (existing) {
      existing.listenerCount++;
    } else {
      listeners.push({
        socketId: connectionId,
        eventName,
        listenerCount: 1,
        addedAt: new Date(),
      });
    }

    this.eventListeners.set(connectionId, listeners);

    // Warn if too many listeners
    const totalListeners = listeners.reduce(
      (sum, l) => sum + l.listenerCount,
      0,
    );
    if (totalListeners > this.config.maxEventListeners) {
      this.logger.warn(
        {
          connectionId,
          totalListeners,
          maxAllowed: this.config.maxEventListeners,
        },
        "Connection has excessive event listeners - potential memory leak",
      );
    }
  }

  /**
   * Track timer creation
   */
  trackTimer(
    id: string,
    type: "timeout" | "interval",
    timer: NodeJS.Timeout,
  ): void {
    this.timers.set(id, {
      id,
      type,
      createdAt: new Date(),
      timer,
    });

    if (this.config.enableDebugLogging) {
      this.logger.debug({ id, type }, "Tracked timer");
    }
  }

  /**
   * Clear a tracked timer
   */
  clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      if (timer.type === "timeout") {
        clearTimeout(timer.timer);
      } else {
        clearInterval(timer.timer);
      }

      this.timers.delete(id);

      if (this.config.enableDebugLogging) {
        this.logger.debug({ id }, "Cleared timer");
      }
    }
  }

  /**
   * Clean up all resources for a connection
   */
  cleanupConnection(connectionId: string): void {
    // Remove event listener tracking
    const listeners = this.eventListeners.get(connectionId);
    if (listeners) {
      this.logger.debug(
        { connectionId, listenerCount: listeners.length },
        "Cleaning up tracked event listeners",
      );
      this.eventListeners.delete(connectionId);
    }

    // Clear any timers associated with this connection
    const connectionTimers = Array.from(this.timers.entries()).filter(([id]) =>
      id.startsWith(connectionId),
    );

    for (const [id] of connectionTimers) {
      this.clearTimer(id);
    }

    // Remove socket reference
    this.socketReferences.delete(connectionId);

    this.logger.debug(
      { connectionId, clearedTimers: connectionTimers.length },
      "Connection cleanup completed",
    );
  }

  /**
   * Perform aggressive cleanup of stale resources
   */
  performAggressiveCleanup(): void {
    this.logger.info("Performing aggressive memory cleanup");

    const now = new Date();
    let cleanedTimers = 0;
    let cleanedListeners = 0;
    let cleanedSockets = 0;

    // Clean up stale timers (older than max cache age)
    for (const [id, timer] of this.timers.entries()) {
      const age = now.getTime() - timer.createdAt.getTime();
      if (age > this.config.maxCacheAge) {
        this.clearTimer(id);
        cleanedTimers++;
      }
    }

    // Clean up stale event listener tracking
    for (const [connectionId, listeners] of this.eventListeners.entries()) {
      const hasStaleListeners = listeners.some((l) => {
        const age = now.getTime() - l.addedAt.getTime();
        return age > this.config.maxCacheAge;
      });

      if (hasStaleListeners) {
        this.eventListeners.delete(connectionId);
        cleanedListeners++;
      }
    }

    // Clean up dead socket references
    for (const [connectionId, weakRef] of this.socketReferences.entries()) {
      if (weakRef.deref() === undefined) {
        this.socketReferences.delete(connectionId);
        cleanedSockets++;
      }
    }

    // Force garbage collection if available
    if (global.gc) {
      global.gc();
      this.logger.debug("Forced garbage collection");
    }

    this.logger.info(
      {
        cleanedTimers,
        cleanedListeners,
        cleanedSockets,
        remainingTimers: this.timers.size,
        remainingListeners: this.eventListeners.size,
        remainingSockets: this.socketReferences.size,
      },
      "Aggressive cleanup completed",
    );
  }

  /**
   * Start memory monitoring
   */
  private startMemoryMonitoring(): void {
    this.memoryCheckInterval = setInterval(() => {
      this.performMemoryCheck();
    }, this.config.memoryCheckInterval);

    // Also setup forced GC interval
    setInterval(() => {
      if (global.gc) {
        global.gc();
        this.logger.debug("Scheduled garbage collection executed");
      }
    }, this.config.forceGCInterval);
  }

  /**
   * Perform memory check and cleanup if needed
   */
  private performMemoryCheck(): void {
    const memUsage = process.memoryUsage();
    const currentTime = Date.now();

    // Calculate memory growth rate
    const timeDiff = currentTime - this.lastMemoryCheck;
    const memoryGrowth =
      timeDiff > 0 ? (memUsage.heapUsed - this.lastMemoryCheck) / timeDiff : 0;

    this.lastMemoryCheck = memUsage.heapUsed;

    // Log memory stats if debug enabled
    if (this.config.enableDebugLogging) {
      this.logger.debug(
        {
          heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
          heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
          rss: Math.round(memUsage.rss / 1024 / 1024),
          external: Math.round(memUsage.external / 1024 / 1024),
          memoryGrowthRate: Math.round(memoryGrowth * 100) / 100,
          trackedTimers: this.timers.size,
          trackedListeners: this.eventListeners.size,
          trackedSockets: this.socketReferences.size,
        },
        "Memory usage check",
      );
    }

    // Trigger aggressive cleanup if memory growth is concerning
    const heapUsagePercent = memUsage.heapUsed / memUsage.heapTotal;
    if (heapUsagePercent > 0.8 || memoryGrowth > 10000) {
      // 10KB/ms growth
      this.logger.warn(
        {
          heapUsagePercent: Math.round(heapUsagePercent * 100),
          memoryGrowthRate: Math.round(memoryGrowth * 100) / 100,
        },
        "High memory usage detected, triggering aggressive cleanup",
      );
      this.performAggressiveCleanup();
    }
  }

  /**
   * Get memory leak prevention statistics
   */
  getStats() {
    const memUsage = process.memoryUsage();

    return {
      memory: {
        heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
        rssMB: Math.round(memUsage.rss / 1024 / 1024),
        externalMB: Math.round(memUsage.external / 1024 / 1024),
        heapUsagePercent: Math.round(
          (memUsage.heapUsed / memUsage.heapTotal) * 100,
        ),
      },
      tracking: {
        trackedTimers: this.timers.size,
        trackedEventListeners: this.eventListeners.size,
        trackedSockets: this.socketReferences.size,
      },
      config: this.config,
    };
  }

  /**
   * Get cache statistics for debugging
   */
  getCacheStats(caches: Map<string, any>[]): CacheStats[] {
    return caches.map((cache, index) => {
      if (cache.size === 0) {
        return {
          name: `cache_${index}`,
          size: 0,
        };
      }

      let oldestEntry: Date | undefined;
      let newestEntry: Date | undefined;

      // Try to find date-based entries
      for (const [, value] of cache.entries()) {
        if (value && typeof value === "object") {
          const date =
            value.createdAt ||
            value.addedAt ||
            value.lastUsed ||
            value.timestamp;
          if (date instanceof Date) {
            if (!oldestEntry || date < oldestEntry) oldestEntry = date;
            if (!newestEntry || date > newestEntry) newestEntry = date;
          }
        }
      }

      return {
        name: `cache_${index}`,
        size: cache.size,
        oldestEntry,
        newestEntry,
      };
    });
  }

  /**
   * Clear all caches and force cleanup
   */
  emergencyCleanup(): void {
    this.logger.warn("Performing emergency memory cleanup");

    // Clear all tracked resources
    for (const [id] of this.timers.entries()) {
      this.clearTimer(id);
    }

    this.eventListeners.clear();
    this.socketReferences.clear();

    // Force multiple GC cycles
    if (global.gc) {
      for (let i = 0; i < 3; i++) {
        global.gc();
      }
      this.logger.info("Emergency cleanup completed with forced GC");
    }
  }

  /**
   * Shutdown memory leak prevention
   */
  shutdown(): void {
    this.logger.info("Shutting down memory leak prevention");

    if (this.memoryCheckInterval) {
      clearInterval(this.memoryCheckInterval);
    }

    // Clear all tracked timers
    for (const [id] of this.timers.entries()) {
      this.clearTimer(id);
    }

    // Clear all tracking data
    this.eventListeners.clear();
    this.socketReferences.clear();

    this.logger.info("Memory leak prevention shutdown complete");
  }
}
