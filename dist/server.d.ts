declare global {
    namespace Express {
        interface Request {
            correlationId?: string;
            startTime?: number;
        }
    }
}
export {};
//# sourceMappingURL=server.d.ts.map