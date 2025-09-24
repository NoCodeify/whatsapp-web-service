import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import pino from "pino";

const logger = pino({ name: "SecretManager" });

export class SecretManager {
	private client: SecretManagerServiceClient;
	private secretCache: Map<string, { value: string; expiresAt: Date }> = new Map();
	private readonly CACHE_TTL = 3600000; // 1 hour cache

	constructor() {
		this.client = new SecretManagerServiceClient();
	}

	/**
	 * Get BrightData API key from Secret Manager
	 */
	async getBrightDataApiKey(): Promise<string> {
		const secretName = process.env.BRIGHT_DATA_API_KEY_SECRET || `projects/${process.env.GOOGLE_CLOUD_PROJECT}/secrets/BRIGHT_DATA_API_KEY/versions/latest`;

		// Check if we have a hardcoded key (for local dev)
		if (process.env.BRIGHT_DATA_API_KEY && process.env.NODE_ENV === "development") {
			logger.warn("Using hardcoded API key from environment variable - only for development!");
			return process.env.BRIGHT_DATA_API_KEY;
		}

		return this.getSecret(secretName);
	}

	/**
	 * Get BrightData Customer ID from Secret Manager
	 */
	async getBrightDataCustomerId(): Promise<string> {
		const secretName =
			process.env.BRIGHT_DATA_CUSTOMER_ID_SECRET || `projects/${process.env.GOOGLE_CLOUD_PROJECT}/secrets/BRIGHT_DATA_CUSTOMER_ID/versions/latest`;

		// Check if we have a hardcoded customer ID (for local dev)
		// Validate it's not a placeholder value
		if (
			process.env.BRIGHT_DATA_CUSTOMER_ID &&
			process.env.NODE_ENV === "development" &&
			!process.env.BRIGHT_DATA_CUSTOMER_ID.includes("your_") &&
			!process.env.BRIGHT_DATA_CUSTOMER_ID.includes("placeholder")
		) {
			logger.warn("Using hardcoded Customer ID from environment variable - only for development!");
			return process.env.BRIGHT_DATA_CUSTOMER_ID;
		}

		return this.getSecret(secretName);
	}

	/**
	 * Get a secret from Google Secret Manager with caching
	 */
	private async getSecret(secretName: string): Promise<string> {
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
		} catch (error: any) {
			logger.error({ error: error.message, secretName }, "Failed to retrieve secret");

			// Fallback to environment variable based on secret type
			if (secretName.includes('BRIGHT_DATA_API_KEY') && process.env.BRIGHT_DATA_API_KEY) {
				logger.warn("Falling back to environment variable for API key");
				return process.env.BRIGHT_DATA_API_KEY;
			} else if (secretName.includes('BRIGHT_DATA_CUSTOMER_ID') && process.env.BRIGHT_DATA_CUSTOMER_ID) {
				// Validate that the customer ID is not a placeholder
				if (!process.env.BRIGHT_DATA_CUSTOMER_ID.includes("your_") &&
					!process.env.BRIGHT_DATA_CUSTOMER_ID.includes("placeholder")) {
					logger.warn("Falling back to environment variable for customer ID");
					return process.env.BRIGHT_DATA_CUSTOMER_ID;
				} else {
					logger.error("Environment variable BRIGHT_DATA_CUSTOMER_ID contains placeholder value");
				}
			}

			throw new Error(`Failed to retrieve secret: ${error.message}`);
		}
	}

	/**
	 * Clear the secret cache (useful for key rotation)
	 */
	clearCache(): void {
		this.secretCache.clear();
		logger.info("Cleared secret cache");
	}
}

// Singleton instance
export const secretManager = new SecretManager();
