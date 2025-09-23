import { Firestore } from "@google-cloud/firestore";
import pino from "pino";
import { EventEmitter } from "events";
import * as os from "os";

export interface InstanceInfo {
  instanceId: string;
  hostname: string;
  startedAt: Date;
  lastHeartbeat: Date;
  status: 'starting' | 'healthy' | 'degraded' | 'shutting_down' | 'failed';
  connections: number;
  maxConnections: number;
  memoryUsage: number;
  cpuUsage: number;
  version: string;
  region?: string;
}

export interface SessionOwnership {
  sessionKey: string; // userId:phoneNumber
  instanceId: string;
  acquiredAt: Date;
  lastActivity: Date;
  status: 'active' | 'transferring' | 'released';
}

export interface CoordinatorConfig {
  heartbeatInterval: number;
  instanceTimeout: number;
  sessionTimeout: number;
  maxConnectionsPerInstance: number;
  enableSessionMigration: boolean;
  loadBalanceStrategy: 'round_robin' | 'least_connections' | 'resource_based';
}

/**
 * Instance coordination service for multi-instance WhatsApp Web Service deployment
 * Manages session ownership, load balancing, and failover handling
 */
export class InstanceCoordinator extends EventEmitter {
  private logger = pino({ name: "InstanceCoordinator" });
  private firestore: Firestore;
  private instanceId: string;
  private heartbeatTimer?: NodeJS.Timeout;
  private sessionCleanupTimer?: NodeJS.Timeout;

  // Local state tracking
  private ownedSessions: Map<string, SessionOwnership> = new Map();
  private instanceRegistry: Map<string, InstanceInfo> = new Map();

  private readonly config: CoordinatorConfig = {
    heartbeatInterval: parseInt(process.env.INSTANCE_HEARTBEAT_INTERVAL || "15000"), // 15 seconds
    instanceTimeout: parseInt(process.env.INSTANCE_TIMEOUT || "60000"), // 60 seconds
    sessionTimeout: parseInt(process.env.SESSION_TIMEOUT || "300000"), // 5 minutes
    maxConnectionsPerInstance: parseInt(process.env.MAX_CONNECTIONS_PER_INSTANCE || "20"),
    enableSessionMigration: process.env.ENABLE_SESSION_MIGRATION !== "false",
    loadBalanceStrategy: (process.env.LOAD_BALANCE_STRATEGY as any) || 'least_connections',
  };

  constructor(firestore: Firestore, instanceId?: string) {
    super();
    this.firestore = firestore;
    this.instanceId = instanceId || this.generateInstanceId();

    this.logger.info(
      { instanceId: this.instanceId, config: this.config },
      "InstanceCoordinator initialized"
    );
  }

  /**
   * Start the instance coordinator
   */
  async start(): Promise<void> {
    try {
      // Register this instance
      await this.registerInstance();

      // Start heartbeat
      this.startHeartbeat();

      // Start session cleanup
      this.startSessionCleanup();

      // Load existing session ownerships
      await this.loadOwnedSessions();

      // Start monitoring other instances
      this.startInstanceMonitoring();

      this.logger.info({ instanceId: this.instanceId }, "Instance coordinator started");
    } catch (error) {
      this.logger.error({ error }, "Failed to start instance coordinator");
      throw error;
    }
  }

  /**
   * Request ownership of a session
   */
  async requestSessionOwnership(userId: string, phoneNumber: string): Promise<boolean> {
    const sessionKey = `${userId}:${phoneNumber}`;

    try {
      // Check if we already own this session
      if (this.ownedSessions.has(sessionKey)) {
        const ownership = this.ownedSessions.get(sessionKey)!;
        ownership.lastActivity = new Date();
        await this.updateSessionOwnership(ownership);
        return true;
      }

      // Check if another instance owns this session
      const existingOwnership = await this.getSessionOwnership(sessionKey);
      if (existingOwnership && existingOwnership.instanceId !== this.instanceId) {
        // Check if the owning instance is still healthy
        const owningInstance = await this.getInstanceInfo(existingOwnership.instanceId);
        if (owningInstance && this.isInstanceHealthy(owningInstance)) {
          this.logger.info(
            { sessionKey, owningInstance: existingOwnership.instanceId },
            "Session is owned by another healthy instance"
          );
          return false;
        } else {
          this.logger.warn(
            { sessionKey, owningInstance: existingOwnership.instanceId },
            "Session owned by unhealthy instance, attempting takeover"
          );
          // Fall through to acquire ownership
        }
      }

      // Check if we can accept more connections
      if (this.ownedSessions.size >= this.config.maxConnectionsPerInstance) {
        this.logger.warn(
          { sessionKey, currentSessions: this.ownedSessions.size },
          "Instance at capacity, cannot accept new session"
        );
        return false;
      }

      // Acquire ownership
      const ownership: SessionOwnership = {
        sessionKey,
        instanceId: this.instanceId,
        acquiredAt: new Date(),
        lastActivity: new Date(),
        status: 'active',
      };

      await this.acquireSessionOwnership(ownership);
      this.ownedSessions.set(sessionKey, ownership);

      this.logger.info({ sessionKey }, "Session ownership acquired");
      return true;

    } catch (error) {
      this.logger.error(
        { sessionKey, error },
        "Failed to request session ownership"
      );
      return false;
    }
  }

  /**
   * Release ownership of a session
   */
  async releaseSessionOwnership(userId: string, phoneNumber: string): Promise<void> {
    const sessionKey = `${userId}:${phoneNumber}`;

    try {
      const ownership = this.ownedSessions.get(sessionKey);
      if (!ownership) {
        this.logger.debug({ sessionKey }, "Session not owned by this instance");
        return;
      }

      // Update status to released
      ownership.status = 'released';
      await this.updateSessionOwnership(ownership);

      // Remove from local tracking
      this.ownedSessions.delete(sessionKey);

      // Delete from Firestore
      await this.firestore
        .collection("session_ownership")
        .doc(sessionKey)
        .delete();

      this.logger.info({ sessionKey }, "Session ownership released");

    } catch (error) {
      this.logger.error(
        { sessionKey, error },
        "Failed to release session ownership"
      );
    }
  }

  /**
   * Update session activity
   */
  async updateSessionActivity(userId: string, phoneNumber: string): Promise<void> {
    const sessionKey = `${userId}:${phoneNumber}`;
    const ownership = this.ownedSessions.get(sessionKey);

    if (ownership) {
      ownership.lastActivity = new Date();
      await this.updateSessionOwnership(ownership);
    }
  }

  /**
   * Get the best instance for a new session
   */
  async getBestInstanceForSession(userId: string, phoneNumber: string): Promise<string | null> {
    try {
      const sessionKey = `${userId}:${phoneNumber}`;

      // Check if session already has an owner
      const existingOwnership = await this.getSessionOwnership(sessionKey);
      if (existingOwnership) {
        const owningInstance = await this.getInstanceInfo(existingOwnership.instanceId);
        if (owningInstance && this.isInstanceHealthy(owningInstance)) {
          return existingOwnership.instanceId;
        }
      }

      // Find the best available instance
      const healthyInstances = await this.getHealthyInstances();

      if (healthyInstances.length === 0) {
        this.logger.warn("No healthy instances available");
        return null;
      }

      // Apply load balancing strategy
      const bestInstance = this.selectBestInstance(healthyInstances);
      return bestInstance?.instanceId || null;

    } catch (error) {
      this.logger.error({ error }, "Failed to get best instance for session");
      return null;
    }
  }

  /**
   * Check if this instance should handle a session
   */
  async shouldHandleSession(userId: string, phoneNumber: string): Promise<boolean> {
    const sessionKey = `${userId}:${phoneNumber}`;

    // Check if we already own the session
    if (this.ownedSessions.has(sessionKey)) {
      return true;
    }

    // Check if we can acquire ownership
    return await this.requestSessionOwnership(userId, phoneNumber);
  }

  /**
   * Generate unique instance ID
   */
  private generateInstanceId(): string {
    const hostname = os.hostname();
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    return `${hostname}-${timestamp}-${random}`;
  }

  /**
   * Register this instance in the registry
   */
  private async registerInstance(): Promise<void> {
    const instanceInfo: InstanceInfo = {
      instanceId: this.instanceId,
      hostname: os.hostname(),
      startedAt: new Date(),
      lastHeartbeat: new Date(),
      status: 'starting',
      connections: 0,
      maxConnections: this.config.maxConnectionsPerInstance,
      memoryUsage: 0,
      cpuUsage: 0,
      version: process.env.npm_package_version || '1.0.0',
      region: process.env.CLOUD_RUN_REGION || 'unknown',
    };

    await this.firestore
      .collection("instance_registry")
      .doc(this.instanceId)
      .set({
        ...instanceInfo,
        startedAt: this.firestore.Timestamp.fromDate(instanceInfo.startedAt),
        lastHeartbeat: this.firestore.Timestamp.fromDate(instanceInfo.lastHeartbeat),
      });

    this.instanceRegistry.set(this.instanceId, instanceInfo);
  }

  /**
   * Start heartbeat process
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.sendHeartbeat();
      } catch (error) {
        this.logger.error({ error }, "Heartbeat failed");
      }
    }, this.config.heartbeatInterval);
  }

  /**
   * Send heartbeat with current status
   */
  private async sendHeartbeat(): Promise<void> {
    const memUsage = process.memoryUsage();
    const memTotal = process.env.MEMORY_LIMIT ?
      parseInt(process.env.MEMORY_LIMIT.replace(/[^0-9]/g, '')) * 1024 * 1024 :
      memUsage.heapTotal;

    const instanceInfo: Partial<InstanceInfo> = {
      lastHeartbeat: new Date(),
      status: 'healthy',
      connections: this.ownedSessions.size,
      memoryUsage: memUsage.rss / memTotal,
      cpuUsage: 0, // TODO: Calculate actual CPU usage
    };

    await this.firestore
      .collection("instance_registry")
      .doc(this.instanceId)
      .update({
        ...instanceInfo,
        lastHeartbeat: this.firestore.Timestamp.fromDate(instanceInfo.lastHeartbeat!),
      });

    // Update local registry
    const localInfo = this.instanceRegistry.get(this.instanceId);
    if (localInfo) {
      Object.assign(localInfo, instanceInfo);
    }
  }

  /**
   * Start session cleanup process
   */
  private startSessionCleanup(): void {
    this.sessionCleanupTimer = setInterval(async () => {
      try {
        await this.cleanupStaleSessions();
        await this.cleanupStaleInstances();
      } catch (error) {
        this.logger.error({ error }, "Session cleanup failed");
      }
    }, 60000); // Every minute
  }

  /**
   * Clean up stale sessions
   */
  private async cleanupStaleSessions(): Promise<void> {
    const staleThreshold = new Date(Date.now() - this.config.sessionTimeout);

    for (const [sessionKey, ownership] of this.ownedSessions.entries()) {
      if (ownership.lastActivity < staleThreshold) {
        this.logger.warn(
          { sessionKey, lastActivity: ownership.lastActivity },
          "Cleaning up stale session"
        );

        await this.releaseSessionOwnership(
          ...sessionKey.split(':') as [string, string]
        );
      }
    }
  }

  /**
   * Clean up stale instances
   */
  private async cleanupStaleInstances(): Promise<void> {
    try {
      const instancesSnapshot = await this.firestore
        .collection("instance_registry")
        .get();

      const staleThreshold = new Date(Date.now() - this.config.instanceTimeout);

      for (const doc of instancesSnapshot.docs) {
        const instance = doc.data() as any;
        const lastHeartbeat = instance.lastHeartbeat.toDate();

        if (lastHeartbeat < staleThreshold && instance.instanceId !== this.instanceId) {
          this.logger.warn(
            { instanceId: instance.instanceId, lastHeartbeat },
            "Cleaning up stale instance"
          );

          // Mark instance as failed
          await doc.ref.update({ status: 'failed' });

          // Clean up sessions owned by this instance
          await this.cleanupInstanceSessions(instance.instanceId);
        }
      }
    } catch (error) {
      this.logger.error({ error }, "Failed to cleanup stale instances");
    }
  }

  /**
   * Clean up sessions owned by a failed instance
   */
  private async cleanupInstanceSessions(instanceId: string): Promise<void> {
    try {
      const sessionsSnapshot = await this.firestore
        .collection("session_ownership")
        .where("instanceId", "==", instanceId)
        .get();

      for (const doc of sessionsSnapshot.docs) {
        await doc.ref.delete();
        this.logger.info(
          { sessionKey: doc.id, failedInstance: instanceId },
          "Cleaned up session from failed instance"
        );
      }
    } catch (error) {
      this.logger.error(
        { instanceId, error },
        "Failed to cleanup sessions from failed instance"
      );
    }
  }

  /**
   * Load sessions owned by this instance
   */
  private async loadOwnedSessions(): Promise<void> {
    try {
      const sessionsSnapshot = await this.firestore
        .collection("session_ownership")
        .where("instanceId", "==", this.instanceId)
        .get();

      for (const doc of sessionsSnapshot.docs) {
        const data = doc.data();
        const ownership: SessionOwnership = {
          sessionKey: doc.id,
          instanceId: data.instanceId,
          acquiredAt: data.acquiredAt.toDate(),
          lastActivity: data.lastActivity.toDate(),
          status: data.status,
        };

        this.ownedSessions.set(doc.id, ownership);
      }

      this.logger.info(
        { sessionCount: this.ownedSessions.size },
        "Loaded owned sessions"
      );
    } catch (error) {
      this.logger.error({ error }, "Failed to load owned sessions");
    }
  }

  /**
   * Start monitoring other instances
   */
  private startInstanceMonitoring(): void {
    // Listen for instance registry changes
    this.firestore
      .collection("instance_registry")
      .onSnapshot((snapshot) => {
        snapshot.docChanges().forEach((change) => {
          const data = change.doc.data();
          const instanceInfo: InstanceInfo = {
            ...data,
            startedAt: data.startedAt.toDate(),
            lastHeartbeat: data.lastHeartbeat.toDate(),
          } as InstanceInfo;

          if (change.type === 'added' || change.type === 'modified') {
            this.instanceRegistry.set(instanceInfo.instanceId, instanceInfo);
          } else if (change.type === 'removed') {
            this.instanceRegistry.delete(instanceInfo.instanceId);
          }
        });
      });
  }

  /**
   * Helper methods
   */
  private async getSessionOwnership(sessionKey: string): Promise<SessionOwnership | null> {
    try {
      const doc = await this.firestore
        .collection("session_ownership")
        .doc(sessionKey)
        .get();

      if (!doc.exists) return null;

      const data = doc.data()!;
      return {
        sessionKey,
        instanceId: data.instanceId,
        acquiredAt: data.acquiredAt.toDate(),
        lastActivity: data.lastActivity.toDate(),
        status: data.status,
      };
    } catch (error) {
      this.logger.error({ sessionKey, error }, "Failed to get session ownership");
      return null;
    }
  }

  private async acquireSessionOwnership(ownership: SessionOwnership): Promise<void> {
    await this.firestore
      .collection("session_ownership")
      .doc(ownership.sessionKey)
      .set({
        instanceId: ownership.instanceId,
        acquiredAt: this.firestore.Timestamp.fromDate(ownership.acquiredAt),
        lastActivity: this.firestore.Timestamp.fromDate(ownership.lastActivity),
        status: ownership.status,
      });
  }

  private async updateSessionOwnership(ownership: SessionOwnership): Promise<void> {
    await this.firestore
      .collection("session_ownership")
      .doc(ownership.sessionKey)
      .update({
        lastActivity: this.firestore.Timestamp.fromDate(ownership.lastActivity),
        status: ownership.status,
      });
  }

  private async getInstanceInfo(instanceId: string): Promise<InstanceInfo | null> {
    try {
      const doc = await this.firestore
        .collection("instance_registry")
        .doc(instanceId)
        .get();

      if (!doc.exists) return null;

      const data = doc.data()!;
      return {
        ...data,
        startedAt: data.startedAt.toDate(),
        lastHeartbeat: data.lastHeartbeat.toDate(),
      } as InstanceInfo;
    } catch (error) {
      this.logger.error({ instanceId, error }, "Failed to get instance info");
      return null;
    }
  }

  private isInstanceHealthy(instance: InstanceInfo): boolean {
    const timeSinceHeartbeat = Date.now() - instance.lastHeartbeat.getTime();
    return (
      instance.status === 'healthy' &&
      timeSinceHeartbeat < this.config.instanceTimeout
    );
  }

  private async getHealthyInstances(): Promise<InstanceInfo[]> {
    return Array.from(this.instanceRegistry.values())
      .filter(instance => this.isInstanceHealthy(instance));
  }

  private selectBestInstance(instances: InstanceInfo[]): InstanceInfo | null {
    if (instances.length === 0) return null;

    switch (this.config.loadBalanceStrategy) {
      case 'least_connections':
        return instances.reduce((best, current) =>
          current.connections < best.connections ? current : best
        );

      case 'resource_based':
        return instances.reduce((best, current) => {
          const currentScore = (1 - current.memoryUsage) * (1 - current.cpuUsage);
          const bestScore = (1 - best.memoryUsage) * (1 - best.cpuUsage);
          return currentScore > bestScore ? current : best;
        });

      case 'round_robin':
      default:
        // Simple round-robin based on instance start time
        return instances.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())[0];
    }
  }

  /**
   * Get coordinator statistics
   */
  getStats() {
    const healthyInstances = Array.from(this.instanceRegistry.values())
      .filter(instance => this.isInstanceHealthy(instance));

    return {
      instanceId: this.instanceId,
      ownedSessions: this.ownedSessions.size,
      totalInstances: this.instanceRegistry.size,
      healthyInstances: healthyInstances.length,
      instances: Array.from(this.instanceRegistry.values()),
      config: this.config,
    };
  }

  /**
   * Get instance ID
   */
  getInstanceId(): string {
    return this.instanceId;
  }

  /**
   * Shutdown coordinator
   */
  async shutdown(): Promise<void> {
    this.logger.info("Shutting down instance coordinator");

    // Clear timers
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    if (this.sessionCleanupTimer) {
      clearInterval(this.sessionCleanupTimer);
    }

    // Release all owned sessions
    const sessionReleases = Array.from(this.ownedSessions.keys()).map(sessionKey => {
      const [userId, phoneNumber] = sessionKey.split(':');
      return this.releaseSessionOwnership(userId, phoneNumber);
    });

    await Promise.all(sessionReleases);

    // Mark instance as shutting down
    try {
      await this.firestore
        .collection("instance_registry")
        .doc(this.instanceId)
        .update({
          status: 'shutting_down',
          lastHeartbeat: this.firestore.Timestamp.now(),
        });
    } catch (error) {
      this.logger.error({ error }, "Failed to update shutdown status");
    }

    this.logger.info("Instance coordinator shutdown complete");
  }
}