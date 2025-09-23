export declare class SecretManager {
  private client;
  private secretCache;
  private readonly CACHE_TTL;
  constructor();
  /**
   * Get BrightData API key from Secret Manager
   */
  getBrightDataApiKey(): Promise<string>;
  /**
   * Get a secret from Google Secret Manager with caching
   */
  private getSecret;
  /**
   * Clear the secret cache (useful for key rotation)
   */
  clearCache(): void;
}
export declare const secretManager: SecretManager;
//# sourceMappingURL=secrets.d.ts.map
