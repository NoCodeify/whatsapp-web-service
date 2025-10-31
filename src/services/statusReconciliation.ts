import { Firestore } from "@google-cloud/firestore";
import pino from "pino";
import { EventEmitter } from "events";
import { ConnectionStateManager } from "./connectionStateManager";

export interface ReconciliationMetrics {
  totalChecks: number;
  desyncDetected: number;
  desyncFixed: number;
  desyncFailed: number;
  lastCheckTime: Date;
  desyncs: Array<{
    userId: string;
    phoneNumber: string;
    inMemoryStatus: string | null;
    firestoreStatus: string | null;
    fixedAt: Date;
    fixed: boolean;
  }>;
}

export class StatusReconciliationService extends EventEmitter {
  private firestore: Firestore;
  private connectionStateManager: ConnectionStateManager;
  private logger = pino({ name: "StatusReconciliationService" });
  private reconciliationInterval: NodeJS.Timeout | null = null;
  private metrics: ReconciliationMetrics = {
    totalChecks: 0,
    desyncDetected: 0,
    desyncFixed: 0,
    desyncFailed: 0,
    lastCheckTime: new Date(),
    desyncs: [],
  };

  private readonly RECONCILIATION_INTERVAL = 120000; // 2 minutes
  private readonly MAX_DESYNCS_TO_TRACK = 100; // Keep last 100 desyncs
  private readonly DESYNC_ALERT_THRESHOLD = 10; // Alert if >10 desyncs in one check

  constructor(
    firestore: Firestore,
    connectionStateManager: ConnectionStateManager,
  ) {
    super();
    this.firestore = firestore;
    this.connectionStateManager = connectionStateManager;
  }

  /**
   * Start the reconciliation service
   */
  start(): void {
    if (this.reconciliationInterval) {
      this.logger.warn("Reconciliation service already running");
      return;
    }

    this.logger.info(
      { intervalMs: this.RECONCILIATION_INTERVAL },
      "Starting status reconciliation service",
    );

    // Run immediately on start
    this.reconcile().catch((error) => {
      this.logger.error({ error }, "Error during initial reconciliation");
    });

    // Then run every 2 minutes
    this.reconciliationInterval = setInterval(async () => {
      try {
        await this.reconcile();
      } catch (error) {
        this.logger.error({ error }, "Error during scheduled reconciliation");
      }
    }, this.RECONCILIATION_INTERVAL);
  }

  /**
   * Stop the reconciliation service
   */
  stop(): void {
    if (this.reconciliationInterval) {
      clearInterval(this.reconciliationInterval);
      this.reconciliationInterval = null;
      this.logger.info("Stopped status reconciliation service");
    }
  }

  /**
   * Perform reconciliation check
   */
  private async reconcile(): Promise<void> {
    const startTime = Date.now();
    this.logger.info("Starting status reconciliation check");

    try {
      // Get all connections from in-memory state
      const inMemoryConnections = new Map<string, string>(); // key: userId:phoneNumber, value: status

      // Access in-memory connections through the connection state manager
      // (We'll need to expose a method to get all in-memory states)
      const activeConnections =
        await this.connectionStateManager.getActiveConnections();

      for (const conn of activeConnections) {
        const key = `${conn.userId}:${conn.phoneNumber}`;
        inMemoryConnections.set(key, conn.status);
      }

      // Get all WhatsApp Web sessions from Firestore
      const firestoreConnections = new Map<string, string>(); // key: userId:phoneNumber, value: status
      const usersSnapshot = await this.firestore.collection("users").get();

      for (const userDoc of usersSnapshot.docs) {
        const userId = userDoc.id;

        const phoneNumbersSnapshot = await userDoc.ref
          .collection("phone_numbers")
          .where("type", "==", "whatsapp_web")
          .get();

        for (const phoneDoc of phoneNumbersSnapshot.docs) {
          const data = phoneDoc.data();
          const phoneNumber = data.phone_number;
          const whatsappData = data.whatsapp_web || {};
          const status = whatsappData.status;

          if (phoneNumber && status) {
            const key = `${userId}:${phoneNumber}`;
            firestoreConnections.set(key, status);
          }
        }
      }

      // Find desyncs
      const desyncsFound: Array<{
        userId: string;
        phoneNumber: string;
        inMemoryStatus: string | null;
        firestoreStatus: string | null;
        fixedAt: Date;
        fixed: boolean;
      }> = [];

      // Check in-memory connections that don't match Firestore
      for (const [key, inMemoryStatus] of inMemoryConnections) {
        const firestoreStatus = firestoreConnections.get(key);

        // Desync detected if:
        // 1. Firestore doesn't have the connection (missing)
        // 2. Firestore has different status
        if (!firestoreStatus || firestoreStatus !== inMemoryStatus) {
          const [userId, phoneNumber] = key.split(":");

          this.logger.warn(
            {
              userId,
              phoneNumber,
              inMemoryStatus,
              firestoreStatus: firestoreStatus || "MISSING",
            },
            "DESYNC DETECTED: In-memory status doesn't match Firestore",
          );

          // Attempt to fix by updating Firestore to match in-memory state
          let fixed = false;
          try {
            const state = await this.connectionStateManager.getState(
              userId,
              phoneNumber,
            );

            if (state) {
              // Force a state update to sync Firestore
              await this.connectionStateManager.updateState(
                userId,
                phoneNumber,
                {
                  status: state.status, // Use current in-memory status
                },
              );

              this.logger.info(
                {
                  userId,
                  phoneNumber,
                  previousFirestoreStatus: firestoreStatus || "MISSING",
                  newStatus: state.status,
                },
                "Successfully fixed desync by updating Firestore",
              );

              fixed = true;
              this.metrics.desyncFixed++;
            }
          } catch (error) {
            this.logger.error(
              {
                userId,
                phoneNumber,
                error,
              },
              "Failed to fix desync",
            );
            this.metrics.desyncFailed++;
          }

          desyncsFound.push({
            userId,
            phoneNumber,
            inMemoryStatus,
            firestoreStatus: firestoreStatus || null,
            fixedAt: new Date(),
            fixed,
          });
        }
      }

      // Check Firestore connections that claim to be "connected" but aren't in memory
      // This indicates stale Firestore data
      for (const [key, firestoreStatus] of firestoreConnections) {
        if (firestoreStatus === "connected" && !inMemoryConnections.has(key)) {
          const [userId, phoneNumber] = key.split(":");

          this.logger.warn(
            {
              userId,
              phoneNumber,
              firestoreStatus,
              inMemory: false,
            },
            "DESYNC DETECTED: Firestore shows 'connected' but no in-memory connection exists (stale data)",
          );

          // Fix by marking as disconnected in Firestore
          let fixed = false;
          try {
            await this.connectionStateManager.markDisconnected(
              userId,
              phoneNumber,
              "Reconciliation: No active in-memory connection found",
            );

            this.logger.info(
              {
                userId,
                phoneNumber,
                previousFirestoreStatus: firestoreStatus,
              },
              "Successfully fixed stale Firestore data by marking as disconnected",
            );

            fixed = true;
            this.metrics.desyncFixed++;
          } catch (error) {
            this.logger.error(
              {
                userId,
                phoneNumber,
                error,
              },
              "Failed to fix stale Firestore data",
            );
            this.metrics.desyncFailed++;
          }

          desyncsFound.push({
            userId,
            phoneNumber,
            inMemoryStatus: null,
            firestoreStatus,
            fixedAt: new Date(),
            fixed,
          });
        }
      }

      // Check for stuck importing states (both in-memory and Firestore agree but stuck in transitional state)
      const stuckImportTimeout = 60000; // 1 minute
      const now = Date.now();

      for (const userDoc of usersSnapshot.docs) {
        const userId = userDoc.id;

        const phoneNumbersSnapshot = await userDoc.ref
          .collection("phone_numbers")
          .where("type", "==", "whatsapp_web")
          .get();

        for (const phoneDoc of phoneNumbersSnapshot.docs) {
          const data = phoneDoc.data();
          const phoneNumber = data.phone_number;
          const whatsappData = data.whatsapp_web || {};
          const status = whatsappData.status;
          const lastUpdated = whatsappData.last_updated?.toDate();

          // Check if stuck in importing state
          if (
            phoneNumber &&
            (status === "importing_contacts" ||
              status === "importing_messages") &&
            lastUpdated
          ) {
            const timeSinceUpdate = now - lastUpdated.getTime();

            if (timeSinceUpdate > stuckImportTimeout) {
              this.logger.warn(
                {
                  userId,
                  phoneNumber,
                  status,
                  timeSinceUpdateMs: timeSinceUpdate,
                  lastUpdated: lastUpdated.toISOString(),
                },
                "STUCK IMPORT DETECTED: Connection stuck in importing state, forcing to connected",
              );

              // Force completion by updating to "connected" and marking sync as completed
              let fixed = false;
              try {
                await this.connectionStateManager.updateState(
                  userId,
                  phoneNumber,
                  {
                    status: "connected",
                    syncCompleted: true, // This will set sync_status to "completed"
                  },
                );

                this.logger.info(
                  {
                    userId,
                    phoneNumber,
                    previousStatus: status,
                    newStatus: "connected",
                    stuckDurationMs: timeSinceUpdate,
                  },
                  "Successfully recovered stuck import by forcing to connected",
                );

                fixed = true;
                this.metrics.desyncFixed++;
              } catch (error) {
                this.logger.error(
                  {
                    userId,
                    phoneNumber,
                    error,
                  },
                  "Failed to fix stuck import",
                );
                this.metrics.desyncFailed++;
              }

              desyncsFound.push({
                userId,
                phoneNumber,
                inMemoryStatus: status,
                firestoreStatus: status,
                fixedAt: new Date(),
                fixed,
              });
            }
          }
        }
      }

      // Update metrics
      this.metrics.totalChecks++;
      this.metrics.desyncDetected += desyncsFound.length;
      this.metrics.lastCheckTime = new Date();

      // Add to tracked desyncs (keep only last N)
      this.metrics.desyncs.push(...desyncsFound);
      if (this.metrics.desyncs.length > this.MAX_DESYNCS_TO_TRACK) {
        this.metrics.desyncs = this.metrics.desyncs.slice(
          -this.MAX_DESYNCS_TO_TRACK,
        );
      }

      const duration = Date.now() - startTime;

      // Emit event for monitoring
      this.emit("reconciliation-complete", {
        duration,
        inMemoryCount: inMemoryConnections.size,
        firestoreCount: firestoreConnections.size,
        desyncsFound: desyncsFound.length,
        desyncsFixed: desyncsFound.filter((d) => d.fixed).length,
        desyncsFailed: desyncsFound.filter((d) => !d.fixed).length,
      });

      // Alert if too many desyncs detected
      if (desyncsFound.length > this.DESYNC_ALERT_THRESHOLD) {
        this.logger.error(
          {
            desyncsFound: desyncsFound.length,
            threshold: this.DESYNC_ALERT_THRESHOLD,
            desyncs: desyncsFound,
          },
          "ALERT: Excessive desyncs detected during reconciliation!",
        );

        this.emit("excessive-desyncs", {
          count: desyncsFound.length,
          threshold: this.DESYNC_ALERT_THRESHOLD,
          desyncs: desyncsFound,
        });
      }

      this.logger.info(
        {
          duration,
          inMemoryConnections: inMemoryConnections.size,
          firestoreConnections: firestoreConnections.size,
          desyncsFound: desyncsFound.length,
          desyncsFixed: desyncsFound.filter((d) => d.fixed).length,
          desyncsFailed: desyncsFound.filter((d) => !d.fixed).length,
        },
        "Status reconciliation check completed",
      );
    } catch (error) {
      this.logger.error(
        {
          error,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack:
            error instanceof Error
              ? error.stack?.split("\n").slice(0, 5).join(" | ")
              : undefined,
        },
        "Critical error during reconciliation",
      );

      this.emit("reconciliation-error", { error });
    }
  }

  /**
   * Get current metrics
   */
  getMetrics(): ReconciliationMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset metrics
   */
  resetMetrics(): void {
    this.metrics = {
      totalChecks: 0,
      desyncDetected: 0,
      desyncFixed: 0,
      desyncFailed: 0,
      lastCheckTime: new Date(),
      desyncs: [],
    };

    this.logger.info("Metrics reset");
  }

  /**
   * Manually trigger a reconciliation check (useful for testing/debugging)
   */
  async manualReconcile(): Promise<void> {
    this.logger.info("Manual reconciliation triggered");
    await this.reconcile();
  }
}
