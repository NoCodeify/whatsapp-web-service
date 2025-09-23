import pino from "pino";
/**
 * Creates a configured pino logger instance optimized for Google Cloud Logging
 *
 * In production: Outputs structured JSON that integrates perfectly with Cloud Logging
 * In development: Outputs pretty-printed logs for better readability
 *
 * @param name - The name/component identifier for this logger instance
 * @returns Configured pino logger
 */
export declare const createLogger: (
  name: string,
) => pino.Logger<never, boolean>;
/**
 * Utility function to mask sensitive data in logs
 */
export declare const maskSensitiveData: (data: any) => any;
/**
 * Performance timer utility for measuring operation duration
 */
export declare class PerfTimer {
  private start;
  private marks;
  constructor();
  mark(name: string): void;
  getMetrics(): {
    totalMs: number;
    marks: {
      [key: string]: number;
    };
  };
}
/**
 * Create a child logger with additional context
 */
export declare const createChildLogger: (
  parentLogger: pino.Logger,
  context: Record<string, any>,
) => pino.Logger;
export declare const defaultLogger: pino.Logger<never, boolean>;
//# sourceMappingURL=logger.d.ts.map
