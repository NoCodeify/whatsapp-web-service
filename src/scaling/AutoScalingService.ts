import pino from "pino";
import { Firestore } from "@google-cloud/firestore";

const logger = pino({ name: "AutoScalingService" });

export interface ScalingMetrics {
  connectionCount: number;
  maxConnections: number;
  memoryUsage: number;
  memoryThreshold: number;
  cpuUsage?: number;
  instanceId: string;
  timestamp: Date;
}

export interface ScalingConfig {
  minInstances: number;
  maxInstances: number;
  scaleUpThreshold: number; // 0.8 = 80%
  scaleDownThreshold: number; // 0.3 = 30%
  cooldownPeriodMs: number; // 5 minutes default
  projectId: string;
  region: string;
  serviceName: string;
}

export class AutoScalingService {
  private firestore: Firestore;
  private config: ScalingConfig;
  private lastScalingAction: Date | null = null;
  private instanceId: string;

  constructor(firestore: Firestore) {
    this.firestore = firestore;
    this.instanceId = process.env.HOSTNAME || `instance_${Date.now()}`;

    this.config = {
      minInstances: parseInt(process.env.MIN_INSTANCES || "1"),
      maxInstances: parseInt(process.env.MAX_INSTANCES || "10"),
      scaleUpThreshold: parseFloat(process.env.SCALE_UP_THRESHOLD || "0.8"),
      scaleDownThreshold: parseFloat(process.env.SCALE_DOWN_THRESHOLD || "0.3"),
      cooldownPeriodMs: parseInt(process.env.SCALING_COOLDOWN_MS || "300000"), // 5 minutes
      projectId: process.env.GOOGLE_CLOUD_PROJECT || "",
      region: process.env.CLOUD_RUN_REGION || "europe-central2",
      serviceName: process.env.CLOUD_RUN_SERVICE_NAME || "whatsapp-web-service",
    };

    logger.info(
      {
        config: this.config,
        instanceId: this.instanceId,
      },
      "AutoScalingService initialized",
    );
  }

  /**
   * Evaluate if scaling action is needed and trigger if necessary
   */
  async evaluateScaling(metrics: ScalingMetrics): Promise<void> {
    try {
      // Check cooldown period
      if (this.isInCooldownPeriod()) {
        logger.debug(
          {
            instanceId: this.instanceId,
            lastAction: this.lastScalingAction,
            cooldownMs: this.config.cooldownPeriodMs,
          },
          "Scaling action skipped - still in cooldown period",
        );
        return;
      }

      // Log current metrics
      await this.logMetrics(metrics);

      // Calculate load percentage
      const connectionLoad = metrics.connectionCount / metrics.maxConnections;
      const memoryLoad = metrics.memoryUsage;

      logger.info(
        {
          instanceId: this.instanceId,
          connectionLoad: `${(connectionLoad * 100).toFixed(1)}%`,
          memoryLoad: `${(memoryLoad * 100).toFixed(1)}%`,
          connectionCount: metrics.connectionCount,
          maxConnections: metrics.maxConnections,
        },
        "Evaluating scaling needs",
      );

      // Determine if scaling is needed
      if (this.shouldScaleUp(connectionLoad, memoryLoad)) {
        await this.scaleUp(metrics);
      } else if (await this.shouldScaleDown(connectionLoad, memoryLoad)) {
        await this.scaleDown(metrics);
      } else {
        logger.debug(
          {
            instanceId: this.instanceId,
            connectionLoad: `${(connectionLoad * 100).toFixed(1)}%`,
            memoryLoad: `${(memoryLoad * 100).toFixed(1)}%`,
          },
          "No scaling action needed",
        );
      }
    } catch (error) {
      logger.error(
        {
          error,
          instanceId: this.instanceId,
          metrics,
        },
        "Failed to evaluate scaling",
      );
    }
  }

  /**
   * Scale up the service (increase instance count)
   */
  private async scaleUp(metrics: ScalingMetrics): Promise<void> {
    try {
      const currentInstances = await this.getCurrentInstanceCount();

      if (currentInstances >= this.config.maxInstances) {
        logger.warn(
          {
            instanceId: this.instanceId,
            currentInstances,
            maxInstances: this.config.maxInstances,
          },
          "Cannot scale up - already at maximum instances",
        );
        return;
      }

      const targetInstances = Math.min(
        currentInstances + 1,
        this.config.maxInstances,
      );

      logger.info(
        {
          instanceId: this.instanceId,
          currentInstances,
          targetInstances,
          trigger: "high_load",
          connectionLoad: `${((metrics.connectionCount / metrics.maxConnections) * 100).toFixed(1)}%`,
          memoryLoad: `${(metrics.memoryUsage * 100).toFixed(1)}%`,
        },
        "Scaling up Cloud Run service",
      );

      await this.updateCloudRunInstances(targetInstances);

      // Record scaling action
      await this.recordScalingAction(
        "scale_up",
        currentInstances,
        targetInstances,
        metrics,
      );
      this.lastScalingAction = new Date();

      logger.info(
        {
          instanceId: this.instanceId,
          from: currentInstances,
          to: targetInstances,
        },
        "Successfully scaled up",
      );
    } catch (error) {
      logger.error(
        {
          error,
          instanceId: this.instanceId,
          metrics,
        },
        "Failed to scale up",
      );
    }
  }

  /**
   * Scale down the service (decrease instance count)
   */
  private async scaleDown(metrics: ScalingMetrics): Promise<void> {
    try {
      const currentInstances = await this.getCurrentInstanceCount();

      if (currentInstances <= this.config.minInstances) {
        logger.debug(
          {
            instanceId: this.instanceId,
            currentInstances,
            minInstances: this.config.minInstances,
          },
          "Cannot scale down - already at minimum instances",
        );
        return;
      }

      const targetInstances = Math.max(
        currentInstances - 1,
        this.config.minInstances,
      );

      logger.info(
        {
          instanceId: this.instanceId,
          currentInstances,
          targetInstances,
          trigger: "low_load",
          connectionLoad: `${((metrics.connectionCount / metrics.maxConnections) * 100).toFixed(1)}%`,
          memoryLoad: `${(metrics.memoryUsage * 100).toFixed(1)}%`,
        },
        "Scaling down Cloud Run service",
      );

      await this.updateCloudRunInstances(targetInstances);

      // Record scaling action
      await this.recordScalingAction(
        "scale_down",
        currentInstances,
        targetInstances,
        metrics,
      );
      this.lastScalingAction = new Date();

      logger.info(
        {
          instanceId: this.instanceId,
          from: currentInstances,
          to: targetInstances,
        },
        "Successfully scaled down",
      );
    } catch (error) {
      logger.error(
        {
          error,
          instanceId: this.instanceId,
          metrics,
        },
        "Failed to scale down",
      );
    }
  }

  /**
   * Check if scaling up is needed
   */
  private shouldScaleUp(connectionLoad: number, memoryLoad: number): boolean {
    return (
      connectionLoad >= this.config.scaleUpThreshold ||
      memoryLoad >= this.config.scaleUpThreshold
    );
  }

  /**
   * Check if scaling down is needed (requires checking other instances)
   */
  private async shouldScaleDown(
    connectionLoad: number,
    memoryLoad: number,
  ): Promise<boolean> {
    if (
      connectionLoad > this.config.scaleDownThreshold ||
      memoryLoad > this.config.scaleDownThreshold
    ) {
      return false;
    }

    // Check if other instances also have low load
    const otherInstancesLowLoad = await this.checkOtherInstancesLoad();
    return otherInstancesLowLoad;
  }

  /**
   * Check if other instances have low load (simplified check)
   */
  private async checkOtherInstancesLoad(): Promise<boolean> {
    try {
      // Get recent metrics from other instances
      const recentMetrics = await this.firestore
        .collection("scaling_metrics")
        .where("timestamp", ">=", new Date(Date.now() - 2 * 60 * 1000)) // Last 2 minutes
        .where("instanceId", "!=", this.instanceId)
        .get();

      if (recentMetrics.empty) {
        // No other instances reporting, safe to scale down
        return true;
      }

      // Check if majority of instances have low load
      let lowLoadInstances = 0;
      let totalInstances = 0;

      recentMetrics.forEach((doc) => {
        const data = doc.data();
        totalInstances++;

        const connectionLoad =
          (data.connectionCount || 0) / (data.maxConnections || 1);
        const memoryLoad = data.memoryUsage || 0;

        if (
          connectionLoad <= this.config.scaleDownThreshold &&
          memoryLoad <= this.config.scaleDownThreshold
        ) {
          lowLoadInstances++;
        }
      });

      // Scale down if majority of instances have low load
      return lowLoadInstances / totalInstances >= 0.7; // 70% threshold
    } catch (error) {
      logger.error(
        {
          error,
          instanceId: this.instanceId,
        },
        "Failed to check other instances load",
      );
      return false; // Don't scale down if we can't verify
    }
  }

  /**
   * Update Cloud Run service instance count
   */
  private async updateCloudRunInstances(
    targetInstances: number,
  ): Promise<void> {
    if (!this.config.projectId) {
      logger.warn("GOOGLE_CLOUD_PROJECT not set, skipping actual scaling");
      return;
    }

    // Use Google Cloud Run Admin API
    const url = `https://run.googleapis.com/v2/projects/${this.config.projectId}/locations/${this.config.region}/services/${this.config.serviceName}`;

    try {
      // For production, you would need proper authentication
      // This is a placeholder for the actual implementation
      logger.info(
        {
          url,
          targetInstances,
          instanceId: this.instanceId,
        },
        "Would update Cloud Run instances (placeholder implementation)",
      );

      // TODO: Implement actual Cloud Run API call with proper authentication
      // await this.callCloudRunAPI(url, targetInstances);
    } catch (error) {
      logger.error(
        {
          error,
          url,
          targetInstances,
        },
        "Failed to update Cloud Run instances",
      );
      throw error;
    }
  }

  /**
   * Get current instance count (simplified implementation)
   */
  private async getCurrentInstanceCount(): Promise<number> {
    try {
      // In a real implementation, this would query Cloud Run API
      // For now, estimate based on recent metrics
      const recentMetrics = await this.firestore
        .collection("scaling_metrics")
        .where("timestamp", ">=", new Date(Date.now() - 5 * 60 * 1000)) // Last 5 minutes
        .get();

      const uniqueInstances = new Set();
      recentMetrics.forEach((doc) => {
        const data = doc.data();
        if (data.instanceId) {
          uniqueInstances.add(data.instanceId);
        }
      });

      const estimatedInstances = Math.max(1, uniqueInstances.size);

      logger.debug(
        {
          estimatedInstances,
          uniqueInstances: Array.from(uniqueInstances),
        },
        "Estimated current instance count",
      );

      return estimatedInstances;
    } catch (error) {
      logger.error({ error }, "Failed to get current instance count");
      return 1; // Default to 1 if we can't determine
    }
  }

  /**
   * Log metrics to Firestore for monitoring
   */
  private async logMetrics(metrics: ScalingMetrics): Promise<void> {
    try {
      await this.firestore.collection("scaling_metrics").add({
        instanceId: this.instanceId,
        connectionCount: metrics.connectionCount,
        maxConnections: metrics.maxConnections,
        memoryUsage: metrics.memoryUsage,
        memoryThreshold: metrics.memoryThreshold,
        cpuUsage: metrics.cpuUsage || null,
        timestamp: metrics.timestamp,
        created_at: new Date(),
      });
    } catch (error) {
      logger.error(
        {
          error,
          instanceId: this.instanceId,
        },
        "Failed to log metrics",
      );
    }
  }

  /**
   * Record scaling action for audit trail
   */
  private async recordScalingAction(
    action: "scale_up" | "scale_down",
    fromInstances: number,
    toInstances: number,
    metrics: ScalingMetrics,
  ): Promise<void> {
    try {
      await this.firestore.collection("scaling_actions").add({
        action,
        instanceId: this.instanceId,
        fromInstances,
        toInstances,
        trigger: {
          connectionCount: metrics.connectionCount,
          maxConnections: metrics.maxConnections,
          memoryUsage: metrics.memoryUsage,
          connectionLoad: metrics.connectionCount / metrics.maxConnections,
        },
        timestamp: new Date(),
        created_at: new Date(),
      });
    } catch (error) {
      logger.error(
        {
          error,
          action,
          instanceId: this.instanceId,
        },
        "Failed to record scaling action",
      );
    }
  }

  /**
   * Check if we're still in cooldown period
   */
  private isInCooldownPeriod(): boolean {
    if (!this.lastScalingAction) {
      return false;
    }

    const timeSinceLastAction = Date.now() - this.lastScalingAction.getTime();
    return timeSinceLastAction < this.config.cooldownPeriodMs;
  }

  /**
   * Get scaling configuration
   */
  getConfig(): ScalingConfig {
    return { ...this.config };
  }

  /**
   * Update scaling configuration
   */
  updateConfig(updates: Partial<ScalingConfig>): void {
    this.config = { ...this.config, ...updates };
    logger.info(
      {
        instanceId: this.instanceId,
        updates,
        newConfig: this.config,
      },
      "Updated scaling configuration",
    );
  }
}
