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
export declare class DynamicProxyService {
  private logger;
  private apiClient;
  private availabilityCache;
  private readonly CACHE_TTL;
  private readonly config;
  private readonly FALLBACK_CHAINS;
  constructor();
  /**
   * Initialize API key from Secret Manager
   */
  private initializeApiKey;
  /**
   * Purchase a new proxy for the specified country
   */
  purchaseProxy(country: string): Promise<ProxyInfo>;
  /**
   * Release a proxy to stop billing
   */
  releaseProxy(ip: string): Promise<void>;
  /**
   * Check if proxies are available for a country
   */
  checkAvailability(country: string): Promise<boolean>;
  /**
   * Get fallback country for unavailable location
   */
  getFallbackCountry(requestedCountry: string): Promise<string>;
  /**
   * Assign a proxy to a user
   */
  assignProxy(
    userId: string,
    phoneNumber: string,
    requestedCountry: string,
  ): Promise<{
    proxy: ProxyInfo;
    fallbackUsed: boolean;
  }>;
  /**
   * Get simplified proxy metrics (no tracking needed)
   */
  getMetrics(): Promise<{
    message: string;
  }>;
}
//# sourceMappingURL=DynamicProxyService.d.ts.map
