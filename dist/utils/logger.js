"use strict";
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultLogger =
  exports.createChildLogger =
  exports.PerfTimer =
  exports.maskSensitiveData =
  exports.createLogger =
    void 0;
const pino_1 = __importDefault(require("pino"));
/**
 * Creates a configured pino logger instance optimized for Google Cloud Logging
 *
 * In production: Outputs structured JSON that integrates perfectly with Cloud Logging
 * In development: Outputs pretty-printed logs for better readability
 *
 * @param name - The name/component identifier for this logger instance
 * @returns Configured pino logger
 */
const createLogger = (name) => {
  const isProduction = process.env.NODE_ENV === "production";
  const isDevelopment = !isProduction;
  return (0, pino_1.default)({
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
      req: pino_1.default.stdSerializers.req,
      res: pino_1.default.stdSerializers.res,
      err: pino_1.default.stdSerializers.err,
    },
    // Format options for better Cloud Logging integration
    formatters: {
      level: (label, number) => {
        // Map pino levels to Cloud Logging severity
        const severityMap = {
          10: "DEBUG", // trace -> DEBUG
          20: "DEBUG", // debug -> DEBUG
          30: "INFO", // info -> INFO
          40: "WARNING", // warn -> WARNING
          50: "ERROR", // error -> ERROR
          60: "CRITICAL", // fatal -> CRITICAL
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
exports.createLogger = createLogger;
/**
 * Utility function to mask sensitive data in logs
 */
const maskSensitiveData = (data) => {
  if (!data) return data;
  const masked = { ...data };
  // List of sensitive field names to mask
  const sensitiveFields = [
    "password",
    "token",
    "apiKey",
    "api_key",
    "secret",
    "authorization",
    "cookie",
  ];
  Object.keys(masked).forEach((key) => {
    const lowerKey = key.toLowerCase();
    if (sensitiveFields.some((field) => lowerKey.includes(field))) {
      masked[key] = "***REDACTED***";
    }
    // Partially mask message content in production
    else if (
      process.env.NODE_ENV === "production" &&
      (lowerKey === "message" || lowerKey === "content" || lowerKey === "text")
    ) {
      if (typeof masked[key] === "string" && masked[key].length > 20) {
        masked[key] = masked[key].substring(0, 20) + "...[truncated]";
      }
    }
  });
  return masked;
};
exports.maskSensitiveData = maskSensitiveData;
/**
 * Performance timer utility for measuring operation duration
 */
class PerfTimer {
  start;
  marks;
  constructor() {
    this.start = Date.now();
    this.marks = new Map();
  }
  mark(name) {
    this.marks.set(name, Date.now());
  }
  getMetrics() {
    const metrics = {};
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
exports.PerfTimer = PerfTimer;
/**
 * Create a child logger with additional context
 */
const createChildLogger = (parentLogger, context) => {
  return parentLogger.child((0, exports.maskSensitiveData)(context));
};
exports.createChildLogger = createChildLogger;
// Export a default logger instance for immediate use
exports.defaultLogger = (0, exports.createLogger)("whatsapp-web-service");
//# sourceMappingURL=logger.js.map
