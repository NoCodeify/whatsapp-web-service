import axios, { AxiosInstance } from "axios";
import pino from "pino";
import { secretManager } from "../config/secrets";

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
  private readonly CACHE_TTL = 3600000; // 1 hour

  private readonly config = {
    apiKey: process.env.BRIGHT_DATA_API_KEY || "",
    customerId: process.env.BRIGHT_DATA_CUSTOMER_ID || "",
    zone: process.env.BRIGHT_DATA_ZONE || "isp_proxy1",
    port: parseInt(process.env.BRIGHT_DATA_PORT || "33335"),
  };

  // Regional fallback chains for unavailable countries
  private readonly FALLBACK_CHAINS: Record<string, string[]> = {
    // Europe
    be: ["nl", "fr", "de", "gb", "us"],
    lu: ["de", "fr", "be", "nl", "gb"],
    mt: ["it", "es", "fr", "gb", "de"],
    is: ["dk", "no", "se", "gb", "de"],

    // Asia
    bd: ["in", "sg", "my", "gb", "us"],
    pk: ["in", "ae", "sg", "gb", "us"],
    lk: ["in", "sg", "my", "gb", "us"],
    np: ["in", "sg", "gb", "us"],

    // Africa
    ng: ["za", "ke", "eg", "gb", "us"],
    gh: ["za", "ng", "gb", "us"],
    ke: ["za", "eg", "ae", "gb", "us"],

    // Caribbean
    jm: ["us", "mx", "br", "gb"],
    bb: ["us", "br", "gb"],
    tt: ["us", "br", "mx", "gb"],

    // Pacific Islands
    fj: ["au", "nz", "sg", "us"],
    gu: ["us", "jp", "au", "sg"],

    // Default fallback for unknown countries
    default: ["us", "gb", "de", "sg", "au", "ca", "fr", "nl", "jp", "br"],
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

    // Initialize API key from Secret Manager
    this.initializeApiKey();
  }

  /**
   * Initialize API key from Secret Manager
   */
  private async initializeApiKey(): Promise<void> {
    try {
      const apiKey = await secretManager.getBrightDataApiKey();

      // Update axios instance with the API key
      this.apiClient.defaults.headers["Authorization"] = `Bearer ${apiKey}`;

      this.logger.info(
        "Successfully initialized BrightData API key from Secret Manager",
      );
    } catch (error: any) {
      this.logger.error(
        { error: error.message },
        "Failed to initialize API key from Secret Manager",
      );

      // Try to use environment variable as fallback
      if (this.config.apiKey) {
        this.apiClient.defaults.headers["Authorization"] =
          `Bearer ${this.config.apiKey}`;
        this.logger.warn("Using API key from environment variable as fallback");
      }
    }
  }

  /**
   * Purchase a new proxy for the specified country
   */
  async purchaseProxy(country: string): Promise<ProxyInfo> {
    try {
      // Purchase new proxy from BrightData
      this.logger.info({ country }, "Purchasing new proxy");

      const response = await this.apiClient.post<ProxyPurchaseResponse>(
        "/zone/ips",
        {
          customer: this.config.customerId,
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
        { country, ip: proxyIp },
        "Successfully purchased proxy",
      );
      return proxyInfo;
    } catch (error: any) {
      this.logger.error(
        { error: error.message, country },
        "Failed to purchase proxy",
      );

      if (
        error.response?.status === 400 ||
        error.message.includes("No proxies available")
      ) {
        // Country not available, will trigger fallback
        throw new Error(`NO_PROXY_AVAILABLE:${country}`);
      }

      throw error;
    }
  }

  /**
   * Release a proxy to stop billing
   */
  async releaseProxy(ip: string): Promise<void> {
    try {
      this.logger.info({ ip }, "Releasing proxy");

      // Call BrightData API to release the IP
      await this.apiClient.delete("/zone/ips", {
        data: {
          customer: this.config.customerId,
          zone: this.config.zone,
          ips: [ip],
        },
      });

      this.logger.info({ ip }, "Successfully released proxy");
    } catch (error: any) {
      this.logger.error(
        { error: error.message, ip },
        "Failed to release proxy",
      );
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
      // Try to get availability from BrightData
      // Note: This endpoint may not exist, so we'll try purchasing with dry_run
      const response = await this.apiClient.post("/zone/ips", {
        customer: this.config.customerId,
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
   * Get fallback country for unavailable location
   */
  async getFallbackCountry(requestedCountry: string): Promise<string> {
    const fallbackChain =
      this.FALLBACK_CHAINS[requestedCountry.toLowerCase()] ||
      this.FALLBACK_CHAINS.default;

    // Try each fallback in order
    for (const fallbackCountry of fallbackChain) {
      if (await this.checkAvailability(fallbackCountry)) {
        this.logger.info(
          { requested: requestedCountry, fallback: fallbackCountry },
          "Using fallback country",
        );
        return fallbackCountry;
      }
    }

    // Last resort - return US (most likely to be available)
    return "us";
  }

  /**
   * Assign a proxy to a user
   */
  async assignProxy(
    userId: string,
    phoneNumber: string,
    requestedCountry: string,
  ): Promise<{ proxy: ProxyInfo; fallbackUsed: boolean }> {
    let country = requestedCountry.toLowerCase();
    let fallbackUsed = false;
    let proxy: ProxyInfo | null = null;

    try {
      // Try to get proxy for requested country
      proxy = await this.purchaseProxy(country);
    } catch (error: any) {
      if (error.message.startsWith("NO_PROXY_AVAILABLE")) {
        // Get fallback country
        country = await this.getFallbackCountry(requestedCountry);
        fallbackUsed = true;

        // Try to purchase proxy for fallback country
        proxy = await this.purchaseProxy(country);
      } else {
        throw error;
      }
    }

    if (!proxy) {
      throw new Error("Failed to obtain proxy");
    }

    this.logger.info(
      {
        userId,
        phoneNumber,
        ip: proxy.ip,
        country: proxy.country,
        fallbackUsed,
      },
      "Proxy assigned to user",
    );

    return { proxy, fallbackUsed };
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
