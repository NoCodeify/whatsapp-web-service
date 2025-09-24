import { Router } from "express";
import { ConnectionPool } from "../core/ConnectionPool";
import { SessionManager } from "../core/SessionManager";
import { ProxyManager } from "../core/ProxyManager";
import { ConnectionStateManager } from "../services/connectionStateManager";
import { ReconnectionService } from "../services/ReconnectionService";
export declare function createApiRoutes(connectionPool: ConnectionPool, sessionManager: SessionManager, proxyManager: ProxyManager, connectionStateManager?: ConnectionStateManager, reconnectionService?: ReconnectionService): Router;
//# sourceMappingURL=routes.d.ts.map