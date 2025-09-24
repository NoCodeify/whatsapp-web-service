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
exports.ConnectionStateManager = void 0;
const admin = __importStar(require("firebase-admin"));
const pino_1 = __importDefault(require("pino"));
const events_1 = require("events");
class ConnectionStateManager extends events_1.EventEmitter {
    firestore;
    logger = (0, pino_1.default)({ name: "ConnectionStateManager" });
    states = new Map();
    heartbeatTimers = new Map();
    HEARTBEAT_INTERVAL = 30000; // 30 seconds
    constructor(firestore) {
        super();
        this.firestore = firestore;
        this.startCleanupTask();
    }
    /**
     * Initialize connection state
     */
    async initializeState(userId, phoneNumber, instanceUrl) {
        const key = this.getStateKey(userId, phoneNumber);
        const state = {
            userId,
            phoneNumber,
            status: "connecting",
            instanceUrl,
            createdAt: new Date(),
            lastActivity: new Date(),
            lastHeartbeat: new Date(),
            messageCount: 0,
            sessionExists: false,
            qrScanned: false,
            syncCompleted: false,
            errorCount: 0,
        };
        // Store in memory
        this.states.set(key, state);
        // Store in Firestore
        await this.persistState(state);
        // Start heartbeat
        this.startHeartbeat(userId, phoneNumber);
        this.logger.info({ userId, phoneNumber }, "Connection state initialized");
        return state;
    }
    /**
     * Update connection state
     */
    async updateState(userId, phoneNumber, updates) {
        const key = this.getStateKey(userId, phoneNumber);
        const state = this.states.get(key);
        if (!state) {
            this.logger.warn({ userId, phoneNumber }, "State not found for update");
            return null;
        }
        // Update state
        Object.assign(state, updates, {
            lastActivity: new Date(),
        });
        // Persist to Firestore
        await this.persistState(state);
        // Emit state change event
        this.emit("state-changed", {
            userId,
            phoneNumber,
            oldStatus: state.status,
            newStatus: updates.status || state.status,
            state,
        });
        return state;
    }
    /**
     * Get connection state
     */
    async getState(userId, phoneNumber) {
        const key = this.getStateKey(userId, phoneNumber);
        // Check memory first
        let state = this.states.get(key);
        if (!state) {
            // Try to load from Firestore
            const loadedState = await this.loadState(userId, phoneNumber);
            if (loadedState) {
                state = loadedState;
                this.states.set(key, state);
                // Restart heartbeat if connection is active
                if (state.status === "connected") {
                    this.startHeartbeat(userId, phoneNumber);
                }
            }
        }
        return state || null;
    }
    /**
     * Get all active connections
     */
    async getActiveConnections() {
        try {
            const states = [];
            // Get all users
            const usersSnapshot = await this.firestore.collection("users").get();
            for (const userDoc of usersSnapshot.docs) {
                const userId = userDoc.id;
                // Get connected sessions for this user
                const sessionsSnapshot = await userDoc.ref
                    .collection("whatsapp_web_sessions")
                    .where("status", "==", "connected")
                    .get();
                for (const sessionDoc of sessionsSnapshot.docs) {
                    const phoneNumber = sessionDoc.id;
                    const data = sessionDoc.data();
                    states.push({
                        userId,
                        phoneNumber,
                        status: data.status,
                        instanceUrl: data.instance_url || "",
                        createdAt: data.created_at?.toDate() || new Date(),
                        lastActivity: data.updated_at?.toDate() || new Date(),
                        lastHeartbeat: data.last_heartbeat?.toDate() ||
                            data.updated_at?.toDate() ||
                            new Date(),
                        messageCount: data.message_count || 0,
                        sessionExists: data.session_exists !== false,
                        qrScanned: data.qr_scanned || false,
                        syncCompleted: data.sync_completed || false,
                        errorCount: data.error_count || 0,
                        lastError: data.last_error,
                    });
                }
            }
            return states;
        }
        catch (error) {
            this.logger.error({ error }, "Failed to get active connections");
            return [];
        }
    }
    /**
     * Recover connections after restart
     */
    async recoverConnections() {
        this.logger.info("Recovering previous connections");
        try {
            const recovered = [];
            // Get all users
            const usersSnapshot = await this.firestore.collection("users").get();
            for (const userDoc of usersSnapshot.docs) {
                const userId = userDoc.id;
                // Get all whatsapp_web_sessions for this user
                const sessionsSnapshot = await userDoc.ref
                    .collection("whatsapp_web_sessions")
                    .get();
                for (const sessionDoc of sessionsSnapshot.docs) {
                    const phoneNumber = sessionDoc.id;
                    const data = sessionDoc.data();
                    // Skip if explicitly logged out
                    if (data.status === "logged_out") {
                        this.logger.debug({
                            userId,
                            phoneNumber,
                            status: data.status,
                        }, "Skipping logged out session");
                        continue;
                    }
                    // Create state from session data
                    const state = {
                        userId,
                        phoneNumber,
                        status: "connecting", // Mark as recovering
                        instanceUrl: data.instance_url || "",
                        createdAt: data.created_at?.toDate() || new Date(),
                        lastActivity: data.updated_at?.toDate() || new Date(),
                        lastHeartbeat: data.updated_at?.toDate() || new Date(),
                        messageCount: 0,
                        sessionExists: true, // Assume true since we're recovering
                        qrScanned: data.status !== "qr_pending",
                        syncCompleted: false,
                        errorCount: 0,
                    };
                    // Store in memory
                    const key = this.getStateKey(userId, phoneNumber);
                    this.states.set(key, state);
                    recovered.push(state);
                    this.logger.info({
                        userId,
                        phoneNumber,
                        previousStatus: data.status,
                    }, "Recovered connection state from whatsapp_web_sessions");
                }
            }
            this.logger.info({
                totalRecovered: recovered.length,
            }, "Connection recovery scan complete");
            return recovered;
        }
        catch (error) {
            this.logger.error({ error }, "Failed to recover connections");
            return [];
        }
    }
    /**
     * Mark connection as connected
     */
    async markConnected(userId, phoneNumber) {
        await this.updateState(userId, phoneNumber, {
            status: "connected",
            sessionExists: true,
            qrScanned: true,
            errorCount: 0,
        });
    }
    /**
     * Mark connection as disconnected
     */
    async markDisconnected(userId, phoneNumber, reason) {
        const key = this.getStateKey(userId, phoneNumber);
        // Stop heartbeat
        this.stopHeartbeat(userId, phoneNumber);
        await this.updateState(userId, phoneNumber, {
            status: "disconnected",
            lastError: reason,
        });
        // Remove from memory after a delay
        setTimeout(() => {
            this.states.delete(key);
        }, 60000); // Keep in memory for 1 minute
    }
    /**
     * Mark connection as failed
     */
    async markFailed(userId, phoneNumber, error) {
        const state = await this.getState(userId, phoneNumber);
        if (state) {
            await this.updateState(userId, phoneNumber, {
                status: "failed",
                errorCount: state.errorCount + 1,
                lastError: error,
            });
        }
        // Stop heartbeat
        this.stopHeartbeat(userId, phoneNumber);
    }
    /**
     * Update sync progress
     */
    async updateSyncProgress(userId, phoneNumber, contacts, messages, completed = false) {
        const state = await this.getState(userId, phoneNumber);
        if (!state)
            return;
        const syncProgress = state.syncProgress || {
            contacts: 0,
            messages: 0,
            startedAt: new Date(),
        };
        syncProgress.contacts = contacts;
        syncProgress.messages = messages;
        if (completed) {
            syncProgress.completedAt = new Date();
        }
        await this.updateState(userId, phoneNumber, {
            syncProgress,
            syncCompleted: completed,
        });
    }
    /**
     * Start heartbeat for connection
     */
    startHeartbeat(userId, phoneNumber) {
        const key = this.getStateKey(userId, phoneNumber);
        // Clear existing timer
        this.stopHeartbeat(userId, phoneNumber);
        // Start new heartbeat timer
        const timer = setInterval(async () => {
            const state = this.states.get(key);
            if (!state || state.status !== "connected") {
                this.stopHeartbeat(userId, phoneNumber);
                return;
            }
            // Update heartbeat
            state.lastHeartbeat = new Date();
            // Persist to Firestore
            await this.persistHeartbeat(userId, phoneNumber);
            this.logger.debug({ userId, phoneNumber }, "Heartbeat sent");
        }, this.HEARTBEAT_INTERVAL);
        this.heartbeatTimers.set(key, timer);
    }
    /**
     * Stop heartbeat for connection
     */
    stopHeartbeat(userId, phoneNumber) {
        const key = this.getStateKey(userId, phoneNumber);
        const timer = this.heartbeatTimers.get(key);
        if (timer) {
            clearInterval(timer);
            this.heartbeatTimers.delete(key);
            this.logger.debug({ userId, phoneNumber }, "Heartbeat stopped");
        }
    }
    /**
     * Persist state to Firestore
     */
    async persistState(state) {
        try {
            // Use the existing whatsapp_web_sessions subcollection
            const ref = this.firestore
                .collection("users")
                .doc(state.userId)
                .collection("whatsapp_web_sessions")
                .doc(state.phoneNumber);
            await ref.set({
                status: state.status,
                instance_url: state.instanceUrl,
                updated_at: admin.firestore.Timestamp.now(),
                session_exists: state.sessionExists,
                qr_scanned: state.qrScanned,
                sync_completed: state.syncCompleted,
                message_count: state.messageCount,
                error_count: state.errorCount,
                last_error: state.lastError,
            }, { merge: true });
        }
        catch (error) {
            this.logger.error({ error, state }, "Failed to persist state");
        }
    }
    /**
     * Persist heartbeat only
     */
    async persistHeartbeat(userId, phoneNumber) {
        try {
            const ref = this.firestore
                .collection("users")
                .doc(userId)
                .collection("whatsapp_web_sessions")
                .doc(phoneNumber);
            await ref.update({
                last_heartbeat: admin.firestore.Timestamp.now(),
                updated_at: admin.firestore.Timestamp.now(),
            });
        }
        catch (error) {
            this.logger.error({ error, userId, phoneNumber }, "Failed to persist heartbeat");
        }
    }
    /**
     * Load state from Firestore
     */
    async loadState(userId, phoneNumber) {
        try {
            const doc = await this.firestore
                .collection("users")
                .doc(userId)
                .collection("whatsapp_web_sessions")
                .doc(phoneNumber)
                .get();
            if (!doc.exists) {
                return null;
            }
            const data = doc.data();
            return {
                userId,
                phoneNumber,
                status: data.status || "disconnected",
                instanceUrl: data.instance_url || "",
                createdAt: data.created_at?.toDate() || new Date(),
                lastActivity: data.updated_at?.toDate() || new Date(),
                lastHeartbeat: data.last_heartbeat?.toDate() ||
                    data.updated_at?.toDate() ||
                    new Date(),
                messageCount: data.message_count || 0,
                sessionExists: data.session_exists !== false,
                qrScanned: data.qr_scanned || data.status !== "qr_pending",
                syncCompleted: data.sync_completed || false,
                errorCount: data.error_count || 0,
                lastError: data.last_error,
                syncProgress: undefined,
            };
        }
        catch (error) {
            this.logger.error({ error, userId, phoneNumber }, "Failed to load state");
            return null;
        }
    }
    /**
     * Start cleanup task
     */
    startCleanupTask() {
        // No longer doing time-based cleanup
        // Connections persist until explicitly logged out
        this.logger.info("Stale connection cleanup disabled - connections persist until logout");
    }
    /**
     * Get state key
     */
    getStateKey(userId, phoneNumber) {
        return `${userId}:${phoneNumber}`;
    }
    /**
     * Get connection metrics
     */
    async getMetrics() {
        const states = Array.from(this.states.values());
        return {
            total: states.length,
            connected: states.filter((s) => s.status === "connected").length,
            connecting: states.filter((s) => s.status === "connecting").length,
            disconnected: states.filter((s) => s.status === "disconnected").length,
            failed: states.filter((s) => s.status === "failed").length,
            qrPending: states.filter((s) => s.status === "qr_pending").length,
            synced: states.filter((s) => s.syncCompleted).length,
            totalMessages: states.reduce((sum, s) => sum + s.messageCount, 0),
        };
    }
    /**
     * Shutdown manager
     */
    async shutdown() {
        this.logger.info("Shutting down connection state manager");
        // Stop all heartbeats
        for (const timer of this.heartbeatTimers.values()) {
            clearInterval(timer);
        }
        this.heartbeatTimers.clear();
        // Persist final states
        for (const state of this.states.values()) {
            await this.persistState(state);
        }
        this.logger.info("Connection state manager shutdown complete");
    }
}
exports.ConnectionStateManager = ConnectionStateManager;
//# sourceMappingURL=connectionStateManager.js.map