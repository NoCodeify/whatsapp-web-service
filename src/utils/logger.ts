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
export const createLogger = (name: string) => {
  const isProduction = process.env.NODE_ENV === "production";
  const isDevelopment = !isProduction;

  return pino({
    name,
    level: process.env.LOG_LEVEL || (isDevelopment ? "debug" : "info"),

    // Production: Pure JSON output for Cloud Logging
    // Development: Pretty printed for human readability
    ...(isDevelopment && {
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss Z",
          ignore: "pid,hostname",
          messageFormat: "{msg} [{name}]",
        },
      },
    }),

    // Base fields for all log entries - optimized for Cloud Logging
    base: {
      service: "whatsapp-web-service",
      version: process.env.SERVICE_VERSION || "1.0.0",
      environment: process.env.NODE_ENV || "production",
      instance: process.env.INSTANCE_ID || process.env.HOSTNAME,
    },

    // Serializers for common objects
    serializers: {
      req: pino.stdSerializers.req,
      res: pino.stdSerializers.res,
      err: pino.stdSerializers.err,
    },

    // Format options for better Cloud Logging integration
    formatters: {
      level: (label: string, number: number) => {
        // Map pino levels to Cloud Logging severity
        const severityMap: { [key: string]: string } = {
          "10": "DEBUG", // trace -> DEBUG
          "20": "DEBUG", // debug -> DEBUG
          "30": "INFO", // info -> INFO
          "40": "WARNING", // warn -> WARNING
          "50": "ERROR", // error -> ERROR
          "60": "CRITICAL", // fatal -> CRITICAL
        };

        return {
          severity: severityMap[String(number)] || "INFO",
          level: number,
          levelName: label,
        };
      },
    },

    // Timestamps in ISO format for Cloud Logging
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  });
};

/**
 * Utility function to mask sensitive data in logs
 */
export const maskSensitiveData = (data: any): any => {
  if (!data) return data;

  const masked = { ...data };

  // List of sensitive field names to mask
  const sensitiveFields = ["password", "token", "apiKey", "api_key", "secret", "authorization", "cookie"];

  Object.keys(masked).forEach((key) => {
    const lowerKey = key.toLowerCase();
    if (sensitiveFields.some((field) => lowerKey.includes(field))) {
      masked[key] = "***REDACTED***";
    }
    // Partially mask message content in production
    else if (process.env.NODE_ENV === "production" && (lowerKey === "message" || lowerKey === "content" || lowerKey === "text")) {
      if (typeof masked[key] === "string" && masked[key].length > 20) {
        masked[key] = masked[key].substring(0, 20) + "...[truncated]";
      }
    }
  });

  return masked;
};

/**
 * Performance timer utility for measuring operation duration
 */
export class PerfTimer {
  private start: number;
  private marks: Map<string, number>;

  constructor() {
    this.start = Date.now();
    this.marks = new Map();
  }

  mark(name: string): void {
    this.marks.set(name, Date.now());
  }

  getMetrics(): { totalMs: number; marks: { [key: string]: number } } {
    const metrics: { [key: string]: number } = {};
    let lastTime = this.start;

    this.marks.forEach((time, name) => {
      metrics[`${name}Ms`] = time - lastTime;
      lastTime = time;
    });

    return {
      totalMs: Date.now() - this.start,
      marks: metrics,
    };
  }
}

/**
 * Create a child logger with additional context
 */
export const createChildLogger = (parentLogger: pino.Logger, context: Record<string, any>): pino.Logger => {
  return parentLogger.child(maskSensitiveData(context));
};

// Export a default logger instance for immediate use
export const defaultLogger = createLogger("whatsapp-web-service");
