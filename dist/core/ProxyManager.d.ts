import { ProxyAgent } from "proxy-agent";
import { DynamicProxyService } from "../services/DynamicProxyService";
import { Firestore } from "@google-cloud/firestore";
export interface ProxyConfig {
    host: string;
    port: number;
    username: string;
    password: string;
    sessionId?: string;
    country?: string;
    type?: "residential" | "isp" | "datacenter";
}
export interface ProxySession {
    userId: string;
    phoneNumber: string;
    sessionId: string;
    proxyIp?: string;
    country?: string;
    selectedCountry?: string;
    createdAt: Date;
    lastUsed: Date;
    rotationCount: number;
}
export interface ProxyLocation {
    code: string;
    name: string;
    flag: string;
    available: boolean;
    region?: string;
}
export declare class ProxyManager {
    private logger;
    private sessions;
    private activeProxies;
    private brightDataService?;
    private dynamicProxyService?;
    private _firestore?;
    private readonly brightDataConfig;
    private readonly availableLocations;
    constructor(firestore?: Firestore, dynamicProxyService?: DynamicProxyService);
    /**
     * Generate a unique session ID for sticky IP assignment
     */
    private generateSessionId;
    /**
     * Get proxy configuration for a specific user/phone combination
     */
    getProxyConfig(userId: string, phoneNumber: string, country?: string): Promise<ProxyConfig | null>;
    /**
     * Create a proxy agent for HTTP/HTTPS requests
     */
    createProxyAgent(userId: string, phoneNumber: string, country?: string): Promise<ProxyAgent | null>;
    /**
     * Get available proxy locations
     */
    getAvailableLocations(): ProxyLocation[];
    /**
     * Find nearest available location based on region
     */
    findNearestLocation(userCountry: string): string;
    /**
     * Release proxy when user disconnects
     */
    releaseProxy(userId: string, phoneNumber: string): Promise<void>;
    /**
     * Rotate proxy by generating a new session ID
     */
    rotateProxy(userId: string, phoneNumber: string): Promise<ProxyConfig | null>;
    /**
     * Get proxy metrics for monitoring
     */
    getMetrics(): Promise<{
        ispProxy?: {
            total: number;
            assigned: number;
            available: number;
            assignments: number;
            utilizationRate: number;
        } | undefined;
        dynamicProxy?: {
            message: string;
        } | undefined;
        activeSessions: number;
        totalRotations: number;
        avgRotationsPerSession: number;
        oldestSessionAge: number;
        proxyType: string;
    }>;
    /**
     * Clean up old sessions
     */
    cleanupSessions(maxAge?: number): number;
    /**
     * Update session with IP information (called after successful connection)
     */
    updateSessionInfo(userId: string, phoneNumber: string, proxyIp: string, country?: string): void;
    /**
     * Get session information
     */
    getSessionInfo(userId: string, phoneNumber: string): ProxySession | null;
    /**
     * Test proxy connection
     */
    testProxyConnection(userId: string, phoneNumber: string): Promise<boolean>;
}
//# sourceMappingURL=ProxyManager.d.ts.map