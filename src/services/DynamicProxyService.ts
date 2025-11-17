import axios, { AxiosInstance } from "axios";
import pino from "pino";
import { secretManager } from "../config/secrets";
import { CountryFallbackAgent } from "./CountryFallbackAgent";

export interface ProxyPurchaseRequest {
  country: string;
  count?: number;
}

export interface ProxyPurchaseResponse {
  ips: number;
  new_ips: string[];
  old_ip_cost?: number;
  new_ip_cost?: number;
}

export interface ProxyInfo {
  ip: string;
  port: number;
  country: string;
}

interface AvailabilityCache {
  country: string;
  available: boolean;
  checkedAt: Date;
}

export class DynamicProxyService {
  private logger = pino({ name: "DynamicProxyService" });
  private apiClient: AxiosInstance;
  private availabilityCache: Map<string, AvailabilityCache> = new Map();
  private customerId: string = "";
  private initializationPromise: Promise<void>;
  private readonly CACHE_TTL = 3600000; // 1 hour

  private readonly config = {
    apiKey: process.env.BRIGHT_DATA_API_KEY || "",
    customerId: process.env.BRIGHT_DATA_CUSTOMER_ID || "",
    zone: process.env.BRIGHT_DATA_ZONE || "isp_proxy1",
    port: parseInt(process.env.BRIGHT_DATA_PORT || "33335"),
  };

  constructor() {
    // Initialize API client with placeholder auth
    this.apiClient = axios.create({
      baseURL: "https://api.brightdata.com",
      headers: {
        "Content-Type": "application/json",
      },
      timeout: 30000,
    });

    // Initialize credentials from Secret Manager (store promise for awaiting)
    this.initializationPromise = this.initializeCredentials();
  }

  /**
   * Initialize credentials from Secret Manager
   */
  private async initializeCredentials(): Promise<void> {
    try {
      // Initialize API key
      const apiKey = await secretManager.getBrightDataApiKey();
      this.apiClient.defaults.headers["Authorization"] = `Bearer ${apiKey}`;

      // Initialize customer ID with validation
      const customerIdFromSecret =
        await secretManager.getBrightDataCustomerId();

      // Validate customer ID is not a placeholder before assignment
      if (
        customerIdFromSecret.includes("your_") ||
        customerIdFromSecret.includes("placeholder")
      ) {
        throw new Error("Customer ID appears to be a placeholder value");
      }

      this.customerId = customerIdFromSecret;

      this.logger.info(
        "Successfully initialized BrightData credentials from Secret Manager",
      );
    } catch (error: any) {
      this.logger.error(
        { error: error.message },
        "Failed to initialize credentials from Secret Manager",
      );

      // Reset customer ID to ensure no placeholder value persists
      this.customerId = "";

      // Try to use environment variables as fallback
      if (this.config.apiKey) {
        this.apiClient.defaults.headers["Authorization"] =
          `Bearer ${this.config.apiKey}`;
        this.logger.warn("Using API key from environment variable as fallback");
      }

      if (
        this.config.customerId &&
        !this.config.customerId.includes("your_") &&
        !this.config.customerId.includes("placeholder")
      ) {
        this.customerId = this.config.customerId;
        this.logger.warn(
          "Using Customer ID from environment variable as fallback",
        );
      } else {
        this.logger.error(
          "No valid Customer ID available - proxy purchases will fail",
        );
      }
    }
  }

  /**
   * Ensure service is initialized before use
   */
  private async ensureInitialized(): Promise<void> {
    await this.initializationPromise;
  }

  /**
   * Check if the service is ready for use
   */
  isReady(): boolean {
    return !!(
      this.customerId && this.apiClient.defaults.headers["Authorization"]
    );
  }

  /**
   * Purchase a new proxy for the specified country
   */
  async purchaseProxy(country: string): Promise<ProxyInfo> {
    const MAX_RETRIES = 3;
    const RETRY_DELAYS = [5000, 10000, 20000]; // 5s, 10s, 20s exponential backoff

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Purchase new proxy from BrightData
        this.logger.info(
          { country, attempt: attempt + 1, maxAttempts: MAX_RETRIES + 1 },
          attempt === 0
            ? "Purchasing new proxy"
            : `Retrying proxy purchase (attempt ${attempt + 1}/${MAX_RETRIES + 1})`,
        );

        // Ensure credentials are initialized
        await this.ensureInitialized();

        if (!this.customerId) {
          throw new Error(
            "Customer ID not initialized - cannot purchase proxy",
          );
        }

        // Validate customer ID is not a placeholder value
        if (
          this.customerId.includes("your_") ||
          this.customerId.includes("placeholder")
        ) {
          throw new Error(
            "Customer ID contains placeholder value - configure valid credentials",
          );
        }

        const response = await this.apiClient.post<ProxyPurchaseResponse>(
          "/zone/ips",
          {
            customer: this.customerId,
            zone: this.config.zone,
            count: 1,
            country: country.toLowerCase(),
          },
        );

        if (!response.data.new_ips || response.data.new_ips.length === 0) {
          throw new Error(`No proxies available for country: ${country}`);
        }

        const proxyIp = response.data.new_ips[0];

        const proxyInfo: ProxyInfo = {
          ip: proxyIp,
          port: this.config.port,
          country: country.toLowerCase(),
        };

        this.logger.info(
          { country, ip: proxyIp, attempt: attempt + 1 },
          "Successfully purchased proxy",
        );
        return proxyInfo;
      } catch (error: any) {
        const errorInfo: any = {
          message: error.message,
          country,
          attempt: attempt + 1,
          maxAttempts: MAX_RETRIES + 1,
          customerId: this.customerId ? "present" : "missing",
        };

        if (axios.isAxiosError(error) && error.response) {
          errorInfo.status = error.response.status;
          errorInfo.statusText = error.response.statusText;
          errorInfo.apiError = error.response.data;
          errorInfo.headers = error.response.headers;
        }

        // Check if this is a retriable error (timeout or network issue)
        const isTimeout =
          error.code === "ECONNABORTED" ||
          error.code === "ETIMEDOUT" ||
          error.message?.includes("timeout") ||
          error.message?.includes("ETIMEDOUT") ||
          error.message?.includes("ECONNABORTED");

        const isNetworkError =
          error.code === "ECONNRESET" ||
          error.code === "ENOTFOUND" ||
          error.code === "ECONNREFUSED";

        const isRetriable = isTimeout || isNetworkError;

        // Check if this is a permanent error
        const isPermanentError =
          error.response?.status === 400 ||
          error.response?.status === 401 ||
          error.response?.status === 403 ||
          error.message.includes("No proxies available") ||
          error.message.includes("Customer ID") ||
          error.message.includes("placeholder");

        this.logger.error(
          {
            ...errorInfo,
            isTimeout,
            isNetworkError,
            isRetriable,
            isPermanentError,
          },
          "Proxy purchase attempt failed",
        );

        // Handle permanent errors - don't retry
        if (isPermanentError) {
          if (
            error.response?.status === 400 ||
            error.message.includes("No proxies available")
          ) {
            // Country not available, will trigger fallback
            throw new Error(`NO_PROXY_AVAILABLE:${country}`);
          }
          throw error;
        }

        // If this is the last attempt, throw the error
        if (attempt === MAX_RETRIES) {
          this.logger.error(
            { country, attempts: MAX_RETRIES + 1 },
            "All proxy purchase attempts failed",
          );
          throw error;
        }

        // Retry on timeout/network errors
        if (isRetriable) {
          const delay = RETRY_DELAYS[attempt];
          this.logger.warn(
            {
              country,
              attempt: attempt + 1,
              nextAttempt: attempt + 2,
              delayMs: delay,
              errorType: isTimeout ? "timeout" : "network",
            },
            `Proxy purchase failed with retriable error, retrying after ${delay}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          // Continue to next iteration
        } else {
          // Non-retriable error, throw immediately
          throw error;
        }
      }
    }

    // This should never be reached, but TypeScript requires it
    throw new Error(
      `Failed to purchase proxy for ${country} after ${MAX_RETRIES + 1} attempts`,
    );
  }

  /**
   * Release a proxy to stop billing
   */
  async releaseProxy(ip: string): Promise<void> {
    try {
      // Ensure credentials are initialized
      await this.ensureInitialized();

      if (!this.customerId) {
        throw new Error("Customer ID not initialized - cannot release proxy");
      }

      // Validate customer ID is not a placeholder value
      if (
        this.customerId.includes("your_") ||
        this.customerId.includes("placeholder")
      ) {
        throw new Error(
          "Customer ID contains placeholder value - configure valid credentials",
        );
      }

      this.logger.info({ ip }, "Releasing proxy");

      // Call BrightData API to release the IP
      await this.apiClient.delete("/zone/ips", {
        data: {
          customer: this.customerId,
          zone: this.config.zone,
          ips: [ip],
        },
      });

      this.logger.info({ ip }, "Successfully released proxy");
    } catch (error: any) {
      const errorInfo: any = {
        message: error.message,
        ip,
        customerId: this.customerId ? "present" : "missing",
      };

      if (axios.isAxiosError(error) && error.response) {
        errorInfo.status = error.response.status;
        errorInfo.statusText = error.response.statusText;
        errorInfo.apiError = error.response.data;
        errorInfo.headers = error.response.headers;
      }

      this.logger.error(errorInfo, "Failed to release proxy");
      throw error;
    }
  }

  /**
   * Check if proxies are available for a country
   */
  async checkAvailability(country: string): Promise<boolean> {
    // Check cache first
    const cached = this.availabilityCache.get(country);
    if (cached && Date.now() - cached.checkedAt.getTime() < this.CACHE_TTL) {
      return cached.available;
    }

    try {
      // Ensure credentials are initialized
      await this.ensureInitialized();

      // Try to get availability from BrightData
      // Note: This endpoint may not exist, so we'll try purchasing with dry_run
      const response = await this.apiClient.post("/zone/ips", {
        customer: this.customerId,
        zone: this.config.zone,
        count: 1,
        country: country.toLowerCase(),
        dry_run: true, // Don't actually purchase
      });

      const available = response.data.available > 0;

      // Update cache
      this.availabilityCache.set(country, {
        country,
        available,
        checkedAt: new Date(),
      });

      return available;
    } catch (error) {
      // If dry_run is not supported, assume country is available
      // and let actual purchase fail if needed
      return true;
    }
  }

  /**
   * Assign a proxy to a user with AI-powered geographic fallback
   */
  async assignProxy(
    userId: string,
    phoneNumber: string,
    requestedCountry: string,
  ): Promise<{
    proxy: ProxyInfo;
    fallbackUsed: boolean;
    originalCountry?: string;
    usedCountry?: string;
  }> {
    const unavailableCountries: string[] = [];
    const MAX_ATTEMPTS = 5; // Try up to 5 different countries
    let currentCountry = requestedCountry.toLowerCase();
    let attempts = 0;

    // Initialize AI agent for fallback suggestions
    const fallbackAgent = new CountryFallbackAgent();

    while (attempts < MAX_ATTEMPTS) {
      try {
        // Try to get proxy for current country
        this.logger.info(
          { currentCountry, attempt: attempts + 1, requestedCountry },
          "Attempting to purchase proxy",
        );

        const proxy = await this.purchaseProxy(currentCountry);

        // Success! Log the result
        const fallbackUsed = currentCountry !== requestedCountry.toLowerCase();
        this.logger.info(
          {
            userId,
            phoneNumber,
            ip: proxy.ip,
            originalCountry: requestedCountry,
            usedCountry: currentCountry,
            fallbackUsed,
            attempts: attempts + 1,
          },
          fallbackUsed
            ? "Proxy assigned using AI-suggested fallback"
            : "Proxy assigned for requested country",
        );

        return {
          proxy,
          fallbackUsed,
          originalCountry: requestedCountry,
          usedCountry: currentCountry,
        };
      } catch (error: any) {
        if (!error.message.startsWith("NO_PROXY_AVAILABLE")) {
          // Not a proxy availability error, throw it
          throw error;
        }

        // Proxy not available for this country
        unavailableCountries.push(currentCountry);
        this.logger.warn(
          {
            unavailableCountry: currentCountry,
            attempt: attempts + 1,
            requestedCountry,
            unavailableCountries,
          },
          "Proxy not available for country, requesting AI fallback",
        );

        attempts++;

        if (attempts >= MAX_ATTEMPTS) {
          // Exhausted all attempts
          throw new Error(
            `No proxy available for ${requestedCountry} after ${MAX_ATTEMPTS} attempts. ` +
              `Tried countries: ${requestedCountry}, ${unavailableCountries.slice(1).join(", ")}`,
          );
        }

        // Use AI agent to get next best country
        try {
          currentCountry = await fallbackAgent.getNextBestCountry(
            requestedCountry,
            unavailableCountries,
          );

          this.logger.info(
            {
              originalCountry: requestedCountry,
              suggestedCountry: currentCountry,
              unavailableCountries,
              attempt: attempts + 1,
            },
            "AI agent suggested fallback country",
          );
        } catch (aiError: any) {
          this.logger.error(
            { error: aiError.message, requestedCountry, unavailableCountries },
            "AI agent failed to suggest fallback country",
          );
          throw new Error(
            `Failed to find fallback country for ${requestedCountry}: ${aiError.message}`,
          );
        }
      }
    }

    // This should never be reached due to the MAX_ATTEMPTS check above
    throw new Error(
      `Failed to obtain proxy after ${MAX_ATTEMPTS} attempts for ${requestedCountry}`,
    );
  }

  /**
   * Get simplified proxy metrics (no tracking needed)
   */
  async getMetrics(): Promise<{
    message: string;
  }> {
    return {
      message: "No proxy tracking - using direct purchase/release model",
    };
  }
}
