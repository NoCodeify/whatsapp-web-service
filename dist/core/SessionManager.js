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
exports.SessionManager = void 0;
const baileys_1 = require("@whiskeysockets/baileys");
const pino_1 = __importDefault(require("pino"));
const storage_1 = require("@google-cloud/storage");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const util_1 = require("util");
const crypto_1 = __importDefault(require("crypto"));
const phoneNumber_1 = require("../utils/phoneNumber");
const writeFile = (0, util_1.promisify)(fs.writeFile);
const readFile = (0, util_1.promisify)(fs.readFile);
const mkdir = (0, util_1.promisify)(fs.mkdir);
const unlink = (0, util_1.promisify)(fs.unlink);
const readdir = (0, util_1.promisify)(fs.readdir);
class SessionManager {
    logger = (0, pino_1.default)({ name: "SessionManager" });
    proxyManager;
    firestore;
    storage;
    sessionsDir;
    sessions = new Map();
    encryptionKey = process.env.SESSION_ENCRYPTION_KEY ||
        crypto_1.default.randomBytes(32).toString("hex");
    bucketName = process.env.STORAGE_BUCKET || "whatsapp-web-sessions";
    storageType = process.env.SESSION_STORAGE_TYPE || "local";
    backupInterval = parseInt(process.env.SESSION_BACKUP_INTERVAL || "300000"); // 5 minutes default
    backupTimers = new Map();
    constructor(proxyManager, firestore) {
        this.proxyManager = proxyManager;
        this.firestore = firestore;
        // Initialize Google Cloud Storage for hybrid or cloud storage modes
        if (this.storageType === "hybrid" || this.storageType === "cloud") {
            this.storage = new storage_1.Storage();
            this.logger.info({
                storageType: this.storageType,
                bucketName: this.bucketName,
            }, "Initialized Google Cloud Storage for session backup");
        }
        this.sessionsDir =
            process.env.SESSION_STORAGE_PATH || path.join(process.cwd(), "sessions");
        this.initializeSessionsDirectory();
    }
    /**
     * Initialize sessions directory
     */
    async initializeSessionsDirectory() {
        try {
            await mkdir(this.sessionsDir, { recursive: true });
            this.logger.info({ dir: this.sessionsDir }, "Sessions directory initialized");
        }
        catch (error) {
            this.logger.error({ error }, "Failed to create sessions directory");
        }
    }
    /**
     * Create a new WhatsApp connection with Baileys
     */
    async createConnection(userId, phoneNumber, proxyCountry, browserName) {
        // Format phone number to ensure consistency
        const formattedPhone = (0, phoneNumber_1.formatPhoneNumberSafe)(phoneNumber);
        if (!formattedPhone) {
            throw new Error(`Invalid phone number format: ${phoneNumber}`);
        }
        phoneNumber = formattedPhone;
        const sessionKey = this.getSessionKey(userId, phoneNumber);
        try {
            // Check for existing session in memory
            const existingSession = this.sessions.get(sessionKey);
            if (existingSession) {
                this.logger.info({ userId, phoneNumber }, "Found existing session in memory, reusing credentials");
                // Don't delete the session or credentials - just proceed with existing auth
                // The session files contain the pairing data we need to reconnect
            }
            // Get or create auth state
            const { state, saveCreds } = await this.getAuthState(userId, phoneNumber);
            // Get proxy agent if configured with country
            const proxyAgent = await this.proxyManager.createProxyAgent(userId, phoneNumber, proxyCountry);
            // Get latest Baileys version
            const { version } = await (0, baileys_1.fetchLatestBaileysVersion)();
            // Create socket configuration
            const socketConfig = {
                auth: {
                    creds: state.creds,
                    keys: (0, baileys_1.makeCacheableSignalKeyStore)(state.keys, this.logger),
                },
                version,
                logger: this.logger.child({ userId, phoneNumber }),
                browser: [browserName || "DM Champ", "Chrome", "120.0.0.0"],
                printQRInTerminal: false,
                // Connection settings
                connectTimeoutMs: 30000,
                defaultQueryTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
                qrTimeout: 90000,
                // Message settings
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: true,
                getMessage: this.getMessage.bind(this),
                // Sync settings - enable full history sync
                syncFullHistory: true, // Sync complete message history
                fireInitQueries: true, // Enable initial queries for contacts
                downloadHistory: true, // Download message history
                shouldSyncHistoryMessage: (_msg) => {
                    // Always sync all history messages
                    // We'll filter them later in processSyncedMessages if needed
                    // This ensures history notifications are processed correctly
                    return true;
                },
                // Retry configuration
                retryRequestDelayMs: 2500,
                maxMsgRetryCount: 5,
            };
            // Add proxy if configured
            if (proxyAgent) {
                socketConfig.agent = proxyAgent;
                socketConfig.fetchAgent = proxyAgent;
                // Get proxy type from environment
                const proxyType = process.env.BRIGHT_DATA_PROXY_TYPE || "residential";
                this.logger.info({
                    userId,
                    phoneNumber,
                    proxyType,
                    proxyCountry: proxyCountry || "auto",
                }, `Using ${proxyType} proxy for WhatsApp connection`);
            }
            // Create socket
            const socket = (0, baileys_1.makeWASocket)(socketConfig);
            // Handle credential updates
            socket.ev.on("creds.update", async () => {
                await saveCreds();
                await this.saveAuthState(userId, phoneNumber, state);
            });
            // Store session data
            const sessionData = {
                userId,
                phoneNumber,
                authState: state,
                createdAt: new Date(),
                lastUsed: new Date(),
            };
            this.sessions.set(sessionKey, sessionData);
            this.logger.info({ userId, phoneNumber }, "WhatsApp connection created");
            return socket;
        }
        catch (error) {
            this.logger.error({ userId, phoneNumber, error }, "Failed to create connection");
            throw error;
        }
    }
    /**
     * Get or create authentication state
     */
    async getAuthState(userId, phoneNumber) {
        const sessionPath = path.join(this.sessionsDir, `${userId}-${phoneNumber}`);
        // Check if local session exists
        const localSessionExists = await this.localSessionExists(sessionPath);
        // In hybrid or cloud mode, try to restore from Cloud Storage if local doesn't exist
        if (!localSessionExists &&
            (this.storageType === "hybrid" || this.storageType === "cloud") &&
            this.storage) {
            try {
                const restored = await this.restoreFromCloudStorage(userId, phoneNumber, sessionPath);
                if (restored) {
                    this.logger.info({ userId, phoneNumber }, "Session restored from Cloud Storage");
                }
            }
            catch (error) {
                this.logger.debug({ userId, phoneNumber, error }, "No existing session in Cloud Storage");
            }
        }
        // Use multi-file auth state
        const authState = await (0, baileys_1.useMultiFileAuthState)(sessionPath);
        // In hybrid mode, setup automatic backup
        if (this.storageType === "hybrid") {
            this.setupAutoBackup(userId, phoneNumber);
        }
        return authState;
    }
    /**
     * Check if local session files exist
     */
    async localSessionExists(sessionPath) {
        try {
            const files = await readdir(sessionPath);
            return files.length > 0;
        }
        catch {
            return false;
        }
    }
    /**
     * Setup automatic backup for hybrid mode
     */
    setupAutoBackup(userId, phoneNumber) {
        const sessionKey = this.getSessionKey(userId, phoneNumber);
        // Clear existing timer if any
        const existingTimer = this.backupTimers.get(sessionKey);
        if (existingTimer) {
            clearInterval(existingTimer);
        }
        // Setup new backup timer
        const timer = setInterval(async () => {
            try {
                await this.backupToCloudStorage(userId, phoneNumber);
                this.logger.debug({ userId, phoneNumber }, "Automatic session backup completed");
            }
            catch (error) {
                this.logger.warn({ userId, phoneNumber, error }, "Automatic backup failed");
            }
        }, this.backupInterval);
        this.backupTimers.set(sessionKey, timer);
        this.logger.info({
            userId,
            phoneNumber,
            backupInterval: this.backupInterval,
        }, "Automatic backup scheduled for session");
    }
    /**
     * Save authentication state to Cloud Storage
     */
    async saveAuthState(userId, phoneNumber, authState) {
        const sessionKey = this.getSessionKey(userId, phoneNumber);
        try {
            // Update local cache
            if (this.sessions.has(sessionKey)) {
                const session = this.sessions.get(sessionKey);
                session.authState = authState;
                session.lastUsed = new Date();
            }
            // Save to Cloud Storage in hybrid or cloud mode
            if ((this.storageType === "hybrid" || this.storageType === "cloud") &&
                this.storage) {
                try {
                    await this.backupToCloudStorage(userId, phoneNumber);
                    // Update Firestore with backup status
                    const sessionRef = this.firestore
                        .collection("users")
                        .doc(userId)
                        .collection("whatsapp_web_sessions")
                        .doc(phoneNumber);
                    await sessionRef.set({
                        session_backed_up: true,
                        last_backup: new Date(),
                        storage_type: this.storageType,
                        bucket_name: this.bucketName,
                        updated_at: new Date(),
                    }, { merge: true });
                    this.logger.debug({
                        userId,
                        phoneNumber,
                        storageType: this.storageType,
                    }, "Session backed up to Cloud Storage");
                }
                catch (error) {
                    this.logger.warn({
                        userId,
                        phoneNumber,
                        error,
                    }, "Failed to backup to Cloud Storage, continuing with local storage");
                }
            }
            this.logger.debug({
                userId,
                phoneNumber,
                storageType: this.storageType,
            }, "Auth state saved");
        }
        catch (error) {
            this.logger.error({ userId, phoneNumber, error }, "Failed to save auth state");
        }
    }
    /**
     * Backup session to Cloud Storage
     */
    async backupToCloudStorage(userId, phoneNumber) {
        if (!this.storage) {
            this.logger.debug({ userId, phoneNumber }, "Cloud Storage not configured, skipping backup");
            return;
        }
        const sessionPath = path.join(this.sessionsDir, `${userId}-${phoneNumber}`);
        const bucket = this.storage.bucket(this.bucketName);
        try {
            // Read all session files
            const files = await readdir(sessionPath);
            for (const file of files) {
                const filePath = path.join(sessionPath, file);
                const fileContent = await readFile(filePath);
                // Encrypt before uploading
                const encrypted = this.encrypt(fileContent);
                // Upload to Cloud Storage
                const blob = bucket.file(`sessions/${userId}/${phoneNumber}/${file}`);
                await blob.save(encrypted, {
                    metadata: {
                        contentType: "application/octet-stream",
                        metadata: {
                            userId,
                            phoneNumber,
                            encrypted: "true",
                        },
                    },
                });
            }
            this.logger.debug({ userId, phoneNumber, files: files.length }, "Session backed up to Cloud Storage");
        }
        catch (error) {
            this.logger.error({ userId, phoneNumber, error }, "Failed to backup session");
            throw error;
        }
    }
    /**
     * Restore session from Cloud Storage
     */
    async restoreFromCloudStorage(userId, phoneNumber, sessionPath) {
        if (!this.storage) {
            this.logger.debug({ userId, phoneNumber }, "Cloud Storage not configured, skipping restore");
            return false;
        }
        const bucket = this.storage.bucket(this.bucketName);
        const prefix = `sessions/${userId}/${phoneNumber}/`;
        try {
            // Create directory if it doesn't exist
            await mkdir(sessionPath, { recursive: true });
            // List all files for this session
            const [files] = await bucket.getFiles({ prefix });
            if (files.length === 0) {
                return false;
            }
            // Download and decrypt each file
            for (const file of files) {
                const fileName = path.basename(file.name);
                const filePath = path.join(sessionPath, fileName);
                const [content] = await file.download();
                // Decrypt content
                const decrypted = this.decrypt(content);
                // Write to local file
                await writeFile(filePath, decrypted);
            }
            this.logger.info({ userId, phoneNumber, files: files.length }, "Session restored from Cloud Storage");
            return true;
        }
        catch (error) {
            this.logger.error({ userId, phoneNumber, error }, "Failed to restore session");
            return false;
        }
    }
    /**
     * Get message from database (for message retries)
     */
    async getMessage(_key) {
        // This is used for message retries
        // In production, you'd fetch from your message database
        // For now, return undefined to let Baileys handle it
        return undefined;
    }
    /**
     * Encrypt data
     */
    encrypt(data) {
        const iv = crypto_1.default.randomBytes(16);
        const cipher = crypto_1.default.createCipheriv("aes-256-cbc", Buffer.from(this.encryptionKey.slice(0, 64), "hex"), iv);
        const encrypted = Buffer.concat([iv, cipher.update(data), cipher.final()]);
        return encrypted;
    }
    /**
     * Decrypt data
     */
    decrypt(data) {
        const iv = data.slice(0, 16);
        const encrypted = data.slice(16);
        const decipher = crypto_1.default.createDecipheriv("aes-256-cbc", Buffer.from(this.encryptionKey.slice(0, 64), "hex"), iv);
        const decrypted = Buffer.concat([
            decipher.update(encrypted),
            decipher.final(),
        ]);
        return decrypted;
    }
    /**
     * Delete a session
     */
    async deleteSession(userId, phoneNumber) {
        // Format phone number for consistency
        const formattedPhone = (0, phoneNumber_1.formatPhoneNumberSafe)(phoneNumber);
        if (formattedPhone) {
            phoneNumber = formattedPhone;
        }
        const sessionKey = this.getSessionKey(userId, phoneNumber);
        const sessionPath = path.join(this.sessionsDir, `${userId}-${phoneNumber}`);
        try {
            // Clear backup timer if exists
            const backupTimer = this.backupTimers.get(sessionKey);
            if (backupTimer) {
                clearInterval(backupTimer);
                this.backupTimers.delete(sessionKey);
                this.logger.debug({ userId, phoneNumber }, "Cleared backup timer for session");
            }
            // Remove from memory
            this.sessions.delete(sessionKey);
            // Delete local files
            try {
                const files = await readdir(sessionPath);
                for (const file of files) {
                    await unlink(path.join(sessionPath, file));
                }
            }
            catch (error) {
                this.logger.debug({ userId, phoneNumber, error }, "No local session files to delete");
            }
            // Delete from Cloud Storage if configured
            if (this.storage &&
                (this.storageType === "hybrid" || this.storageType === "cloud")) {
                try {
                    const bucket = this.storage.bucket(this.bucketName);
                    const prefix = `sessions/${userId}/${phoneNumber}/`;
                    const [cloudFiles] = await bucket.getFiles({ prefix });
                    for (const file of cloudFiles) {
                        await file.delete();
                    }
                    this.logger.info({
                        userId,
                        phoneNumber,
                        deletedFiles: cloudFiles.length,
                    }, "Deleted session files from Cloud Storage");
                }
                catch (error) {
                    this.logger.debug({ userId, phoneNumber, error }, "Error deleting from Cloud Storage");
                }
            }
            // Update Firestore
            const sessionRef = this.firestore
                .collection("users")
                .doc(userId)
                .collection("whatsapp_web_sessions")
                .doc(phoneNumber);
            await sessionRef.delete();
            this.logger.info({ userId, phoneNumber }, "Session deleted");
        }
        catch (error) {
            this.logger.error({ userId, phoneNumber, error }, "Failed to delete session");
            throw error;
        }
    }
    /**
     * Check if session exists
     */
    async sessionExists(userId, phoneNumber) {
        // Format phone number for consistency
        const formattedPhone = (0, phoneNumber_1.formatPhoneNumberSafe)(phoneNumber);
        if (formattedPhone) {
            phoneNumber = formattedPhone;
        }
        const sessionPath = path.join(this.sessionsDir, `${userId}-${phoneNumber}`);
        try {
            const files = await readdir(sessionPath);
            return files.length > 0;
        }
        catch {
            // Try Cloud Storage if configured
            if (this.storage) {
                try {
                    const bucket = this.storage.bucket(this.bucketName);
                    const prefix = `sessions/${userId}/${phoneNumber}/`;
                    const [files] = await bucket.getFiles({ prefix, maxResults: 1 });
                    return files.length > 0;
                }
                catch (error) {
                    this.logger.debug({ userId, phoneNumber, error }, "Error checking Cloud Storage for session");
                }
            }
            return false;
        }
    }
    /**
     * List all sessions from the filesystem
     */
    async listAllSessions() {
        const sessions = [];
        try {
            // Read all directories in sessions folder
            const dirs = await readdir(this.sessionsDir);
            for (const dir of dirs) {
                // Skip non-directory entries
                const dirPath = path.join(this.sessionsDir, dir);
                const stats = await fs.promises.stat(dirPath);
                if (!stats.isDirectory())
                    continue;
                // Parse directory name (format: userId-phoneNumber)
                const parts = dir.split("-");
                if (parts.length >= 2) {
                    // Handle case where phoneNumber might contain dashes
                    const userId = parts[0];
                    const phoneNumber = parts.slice(1).join("-");
                    // Check if this session has a creds.json file (indicates valid session)
                    try {
                        const credsPath = path.join(dirPath, "creds.json");
                        await fs.promises.access(credsPath, fs.constants.F_OK);
                        // Session has credentials, add to list
                        sessions.push({ userId, phoneNumber });
                        this.logger.debug({
                            userId,
                            phoneNumber,
                            dir,
                        }, "Found valid session directory");
                    }
                    catch {
                        // No creds.json, skip this directory
                        this.logger.debug({ dir }, "Session directory missing creds.json, skipping");
                    }
                }
                else {
                    this.logger.debug({ dir }, "Invalid session directory name format");
                }
            }
            this.logger.info({
                count: sessions.length,
            }, "Listed all sessions from filesystem");
            return sessions;
        }
        catch (error) {
            this.logger.error({ error }, "Failed to list sessions");
            return [];
        }
    }
    /**
     * Get session metrics
     */
    getMetrics() {
        const sessions = Array.from(this.sessions.values());
        return {
            totalSessions: this.sessions.size,
            averageSessionAge: sessions.length > 0
                ? sessions.reduce((sum, s) => sum + (Date.now() - s.createdAt.getTime()), 0) / sessions.length
                : 0,
            oldestSession: sessions.reduce((oldest, s) => (!oldest || s.createdAt < oldest.createdAt ? s : oldest), null),
        };
    }
    /**
     * Cleanup old sessions
     */
    async cleanupSessions(maxAge = 30 * 24 * 60 * 60 * 1000) {
        const now = Date.now();
        let cleanedLocal = 0;
        let cleanedCloud = 0;
        // Cleanup in-memory sessions
        for (const [key, session] of this.sessions.entries()) {
            if (now - session.lastUsed.getTime() > maxAge) {
                const [userId, phoneNumber] = key.split(":");
                try {
                    // Delete the entire session (local + cloud)
                    await this.deleteSession(userId, phoneNumber);
                    cleanedLocal++;
                }
                catch (error) {
                    this.logger.error({ userId, phoneNumber, error }, "Failed to cleanup session");
                }
            }
        }
        // Cleanup orphaned local directories
        try {
            const sessionDirs = await readdir(this.sessionsDir);
            for (const dir of sessionDirs) {
                const sessionPath = path.join(this.sessionsDir, dir);
                const stats = await fs.promises.stat(sessionPath);
                // Check if directory is older than maxAge
                if (now - stats.mtime.getTime() > maxAge) {
                    const [userId, phoneNumber] = dir.split("-");
                    // Check if session is still active
                    const sessionKey = this.getSessionKey(userId, phoneNumber);
                    if (!this.sessions.has(sessionKey)) {
                        try {
                            // Remove orphaned directory
                            await fs.promises.rm(sessionPath, {
                                recursive: true,
                                force: true,
                            });
                            cleanedLocal++;
                            this.logger.info({ dir }, "Removed orphaned session directory");
                        }
                        catch (error) {
                            this.logger.error({ dir, error }, "Failed to remove orphaned directory");
                        }
                    }
                }
            }
        }
        catch (error) {
            this.logger.debug({ error }, "Error scanning session directories");
        }
        // Cleanup old cloud storage sessions if configured
        if (this.storage &&
            (this.storageType === "hybrid" || this.storageType === "cloud")) {
            try {
                const bucket = this.storage.bucket(this.bucketName);
                const [files] = await bucket.getFiles({ prefix: "sessions/" });
                for (const file of files) {
                    const metadata = file.metadata;
                    const timeCreated = metadata.timeCreated;
                    if (!timeCreated)
                        continue;
                    const created = new Date(timeCreated);
                    if (now - created.getTime() > maxAge) {
                        try {
                            await file.delete();
                            cleanedCloud++;
                        }
                        catch (error) {
                            this.logger.error({ file: file.name, error }, "Failed to delete old cloud session file");
                        }
                    }
                }
                if (cleanedCloud > 0) {
                    this.logger.info({ cleanedCloud }, "Cleaned up old sessions from cloud storage");
                }
            }
            catch (error) {
                this.logger.error({ error }, "Failed to cleanup cloud storage sessions");
            }
        }
        const totalCleaned = cleanedLocal + cleanedCloud;
        if (totalCleaned > 0) {
            this.logger.info({
                cleanedLocal,
                cleanedCloud,
                totalCleaned,
            }, "Session cleanup completed");
        }
        return totalCleaned;
    }
    /**
     * Helper method to get session key
     */
    getSessionKey(userId, phoneNumber) {
        // Phone number should already be formatted by this point
        // but ensure consistency just in case
        const formattedPhone = (0, phoneNumber_1.formatPhoneNumberSafe)(phoneNumber) || phoneNumber;
        return `${userId}:${formattedPhone}`;
    }
    /**
     * Shutdown the session manager and cleanup resources
     */
    async shutdown() {
        this.logger.info("Shutting down SessionManager");
        // Clear all backup timers
        for (const [sessionKey, timer] of this.backupTimers.entries()) {
            clearInterval(timer);
            this.logger.debug({ sessionKey }, "Cleared backup timer");
        }
        this.backupTimers.clear();
        // Perform final backup for all active sessions in hybrid mode
        if (this.storageType === "hybrid" && this.storage) {
            const backupPromises = [];
            for (const [sessionKey] of this.sessions.entries()) {
                const [userId, phoneNumber] = sessionKey.split(":");
                backupPromises.push(this.backupToCloudStorage(userId, phoneNumber).catch((error) => {
                    this.logger.error({ userId, phoneNumber, error }, "Failed final backup during shutdown");
                }));
            }
            if (backupPromises.length > 0) {
                this.logger.info({ sessions: backupPromises.length }, "Performing final backup of all sessions");
                await Promise.all(backupPromises);
            }
        }
        // Clear sessions from memory
        this.sessions.clear();
        this.logger.info("SessionManager shutdown complete");
    }
}
exports.SessionManager = SessionManager;
//# sourceMappingURL=SessionManager.js.map