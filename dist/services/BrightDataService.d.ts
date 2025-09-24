import { Firestore } from "@google-cloud/firestore";
export interface StaticIP {
    ip: string;
    port: number;
    country: string;
    city?: string;
    isp?: string;
    status: "active" | "inactive" | "assigned";
    assignedTo?: string;
    assignedAt?: Date;
    lastHealthCheck?: Date;
    sessionId?: string;
}
export interface IPAssignment {
    phoneNumber: string;
    userId: string;
    ipAddress: string;
    port: number;
    assignedAt: Date;
    lastUsed: Date;
    country?: string;
    sessionId: string;
}
export declare class BrightDataService {
    private logger;
    private apiClient;
    private firestore;
    private staticIPs;
    private assignments;
    private readonly config;
    constructor(firestore: Firestore);
    /**
     * Load existing IP assignments from Firestore
     */
    private loadAssignments;
    /**
     * Sync available static IPs from Bright Data API
     */
    private syncStaticIPs;
    /**
     * Generate session-based IP placeholders for ISP proxy
     */
    private generateSessionBasedIPs;
    /**
     * Generate a session-based IP identifier
     */
    private generateSessionBasedIP;
    /**
     * Get an available static IP for a phone number
     */
    assignStaticIP(userId: string, phoneNumber: string, preferredCountry?: string): Promise<StaticIP | null>;
    /**
     * Release an IP assignment
     */
    releaseIP(phoneNumber: string): Promise<void>;
    /**
     * Get proxy configuration for a phone number
     */
    getProxyConfig(userId: string, phoneNumber: string): Promise<any>;
    /**
     * Test proxy connection
     */
    testConnection(phoneNumber?: string): Promise<boolean>;
    /**
     * Get all IP assignments
     */
    getAssignments(): IPAssignment[];
    /**
     * Get all available IPs
     */
    getAvailableIPs(): StaticIP[];
    /**
     * Get metrics
     */
    getMetrics(): {
        total: number;
        assigned: number;
        available: number;
        assignments: number;
        utilizationRate: number;
    };
}
//# sourceMappingURL=BrightDataService.d.ts.map