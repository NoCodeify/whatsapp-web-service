import { Firestore } from "@google-cloud/firestore";
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
  scaleUpThreshold: number;
  scaleDownThreshold: number;
  cooldownPeriodMs: number;
  projectId: string;
  region: string;
  serviceName: string;
}
export declare class AutoScalingService {
  private firestore;
  private config;
  private lastScalingAction;
  private instanceId;
  constructor(firestore: Firestore);
  /**
   * Evaluate if scaling action is needed and trigger if necessary
   */
  evaluateScaling(metrics: ScalingMetrics): Promise<void>;
  /**
   * Scale up the service (increase instance count)
   */
  private scaleUp;
  /**
   * Scale down the service (decrease instance count)
   */
  private scaleDown;
  /**
   * Check if scaling up is needed
   */
  private shouldScaleUp;
  /**
   * Check if scaling down is needed (requires checking other instances)
   */
  private shouldScaleDown;
  /**
   * Check if other instances have low load (simplified check)
   */
  private checkOtherInstancesLoad;
  /**
   * Update Cloud Run service instance count
   */
  private updateCloudRunInstances;
  /**
   * Get current instance count (simplified implementation)
   */
  private getCurrentInstanceCount;
  /**
   * Log metrics to Firestore for monitoring
   */
  private logMetrics;
  /**
   * Record scaling action for audit trail
   */
  private recordScalingAction;
  /**
   * Check if we're still in cooldown period
   */
  private isInCooldownPeriod;
  /**
   * Get scaling configuration
   */
  getConfig(): ScalingConfig;
  /**
   * Update scaling configuration
   */
  updateConfig(updates: Partial<ScalingConfig>): void;
}
//# sourceMappingURL=AutoScalingService.d.ts.map
