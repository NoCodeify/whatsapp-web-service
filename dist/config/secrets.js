"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.secretManager = exports.SecretManager = void 0;
const secret_manager_1 = require("@google-cloud/secret-manager");
const pino_1 = __importDefault(require("pino"));
const logger = (0, pino_1.default)({ name: "SecretManager" });
class SecretManager {
    client;
    secretCache = new Map();
    CACHE_TTL = 3600000; // 1 hour cache
    constructor() {
        this.client = new secret_manager_1.SecretManagerServiceClient();
    }
    /**
     * Get BrightData API key from Secret Manager
     */
    async getBrightDataApiKey() {
        const secretName = process.env.BRIGHT_DATA_API_KEY_SECRET ||
            `projects/${process.env.GOOGLE_CLOUD_PROJECT}/secrets/bright-data-api-key/versions/latest`;
        // Check if we have a hardcoded key (for local dev)
        if (process.env.BRIGHT_DATA_API_KEY &&
            process.env.NODE_ENV === "development") {
            logger.warn("Using hardcoded API key from environment variable - only for development!");
            return process.env.BRIGHT_DATA_API_KEY;
        }
        return this.getSecret(secretName);
    }
    /**
     * Get BrightData Customer ID from Secret Manager
     */
    async getBrightDataCustomerId() {
        const secretName = process.env.BRIGHT_DATA_CUSTOMER_ID_SECRET ||
            `projects/${process.env.GOOGLE_CLOUD_PROJECT}/secrets/bright-data-customer-id/versions/latest`;
        // Check if we have a hardcoded customer ID (for local dev)
        // Validate it's not a placeholder value
        if (process.env.BRIGHT_DATA_CUSTOMER_ID &&
            process.env.NODE_ENV === "development" &&
            !process.env.BRIGHT_DATA_CUSTOMER_ID.includes("your_") &&
            !process.env.BRIGHT_DATA_CUSTOMER_ID.includes("placeholder")) {
            logger.warn("Using hardcoded Customer ID from environment variable - only for development!");
            return process.env.BRIGHT_DATA_CUSTOMER_ID;
        }
        return this.getSecret(secretName);
    }
    /**
     * Get a secret from Google Secret Manager with caching
     */
    async getSecret(secretName) {
        // Check cache first
        const cached = this.secretCache.get(secretName);
        if (cached && cached.expiresAt > new Date()) {
            return cached.value;
        }
        try {
            // Access the secret version
            const [version] = await this.client.accessSecretVersion({
                name: secretName,
            });
            // Extract the payload as a string
            const payload = version.payload?.data;
            if (!payload) {
                throw new Error(`Secret ${secretName} has no data`);
            }
            const secretValue = payload.toString();
            // Cache the secret
            this.secretCache.set(secretName, {
                value: secretValue,
                expiresAt: new Date(Date.now() + this.CACHE_TTL),
            });
            logger.info({ secretName }, "Successfully retrieved secret from Secret Manager");
            return secretValue;
        }
        catch (error) {
            logger.error({ error: error.message, secretName }, "Failed to retrieve secret");
            // Fallback to environment variable if Secret Manager fails
            if (process.env.BRIGHT_DATA_API_KEY) {
                logger.warn("Falling back to environment variable for API key");
                return process.env.BRIGHT_DATA_API_KEY;
            }
            throw new Error(`Failed to retrieve secret: ${error.message}`);
        }
    }
    /**
     * Clear the secret cache (useful for key rotation)
     */
    clearCache() {
        this.secretCache.clear();
        logger.info("Cleared secret cache");
    }
}
exports.SecretManager = SecretManager;
// Singleton instance
exports.secretManager = new SecretManager();
//# sourceMappingURL=secrets.js.map