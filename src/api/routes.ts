import { Router, Request, Response } from "express";
import QRCode from "qrcode";
import { ConnectionPool } from "../core/ConnectionPool";
import { SessionManager } from "../core/SessionManager";
import { ProxyManager } from "../core/ProxyManager";
import { ConnectionStateManager } from "../services/connectionStateManager";
import { LimitChecker } from "../services/limitChecker";
import { ReconnectionService } from "../services/ReconnectionService";
import pino from "pino";
import { WAMessageContent } from "@whiskeysockets/baileys";
import { formatPhoneNumberSafe } from "../utils/phoneNumber";

const logger = pino({ name: "API" });
const limitChecker = new LimitChecker();

// Extend Request to include authenticated user
interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    role?: string;
  };
}

// Simple API key authentication middleware
const authenticate = (
  req: AuthenticatedRequest,
  res: Response,
  next: Function,
) => {
  // Skip authentication for OPTIONS requests (CORS preflight)
  if (req.method === "OPTIONS") {
    next();
    return;
  }

  const apiKey = req.headers["x-api-key"] as string;

  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Extract user ID from request
  const userId =
    (req.headers["x-user-id"] as string) || req.body.userId || req.query.userId;

  if (!userId) {
    return res.status(400).json({ error: "User ID required" });
  }

  req.user = { userId };
  next();
  return;
};

export function createApiRoutes(
  connectionPool: ConnectionPool,
  sessionManager: SessionManager,
  proxyManager: ProxyManager,
  connectionStateManager?: ConnectionStateManager,
  reconnectionService?: ReconnectionService,
): Router {
  const router = Router();

  // Apply authentication to all routes
  router.use(authenticate);

  /**
   * POST /sessions/initialize
   * Initialize a new WhatsApp Web connection
   */
  router.post(
    "/sessions/initialize",
    async (req: AuthenticatedRequest, res: Response): Promise<any> => {
      try {
        const { phoneNumber, proxyCountry, countryCode, browserName, forceNew } =
          req.body;
        const userId = req.user!.userId;

        if (!phoneNumber) {
          return res.status(400).json({ error: "Phone number required" });
        }

        // Format and validate the phone number
        const formattedPhone = formatPhoneNumberSafe(phoneNumber, countryCode);
        if (!formattedPhone) {
          logger.warn(
            { userId, phoneNumber, countryCode },
            "Invalid phone number format",
          );
          return res.status(400).json({
            error: "Invalid phone number format",
            message:
              "Please provide a valid phone number with country code (e.g., +31612345678)",
          });
        }

        logger.info(
          { userId, original: phoneNumber, formatted: formattedPhone },
          "Formatted phone number",
        );

        // Check if session already exists
        const existing = connectionPool.getConnection(userId, formattedPhone);
        if (existing && existing.state.connection === "open") {
          return res.json({
            status: "already_connected",
            phoneNumber: formattedPhone,
            instanceUrl: existing.instanceUrl,
          });
        }

        // Add connection to pool with optional country, country code, and browser name
        const added = await connectionPool.addConnection(
          userId,
          formattedPhone,
          proxyCountry,
          countryCode,
          false,
          browserName,
          forceNew,
        );

        if (!added) {
          return res.status(503).json({
            error: "Service at capacity",
            message: "Please try again later or contact support",
          });
        }

        // Get connection to check for QR
        const connection = connectionPool.getConnection(userId, formattedPhone);

        res.json({
          status: "initializing",
          phoneNumber: formattedPhone,
          instanceUrl:
            process.env.INSTANCE_URL ||
            `http://localhost:${process.env.PORT || 8080}`,
          sessionId: `${userId}-${formattedPhone}`,
          qrEndpoint: connection?.qrCode ? `/api/sessions/${userId}/qr` : null,
        });
      } catch (error) {
        logger.error(
          { error, userId: req.user?.userId },
          "Failed to initialize session",
        );
        return res.status(500).json({ error: "Failed to initialize session" });
      }
    },
  );

  /**
   * GET /sessions/:userId/qr
   * Get QR code for authentication
   */
  router.get(
    "/sessions/:userId/qr",
    async (req: AuthenticatedRequest, res: Response): Promise<any> => {
      try {
        const { userId } = req.params;
        const phoneNumber = req.query.phoneNumber as string;

        if (!phoneNumber) {
          return res.status(400).json({ error: "Phone number required" });
        }

        // Format the phone number for consistent lookup
        const formattedPhone = formatPhoneNumberSafe(phoneNumber);
        if (!formattedPhone) {
          return res.status(400).json({
            error: "Invalid phone number format",
          });
        }

        // Verify user access
        if (req.user!.userId !== userId) {
          return res.status(403).json({ error: "Forbidden" });
        }

        const connection = connectionPool.getConnection(userId, formattedPhone);

        if (!connection) {
          return res.status(404).json({ error: "Connection not found" });
        }

        // Don't check expiration - just return current state
        // Baileys will emit new QR via WebSocket when ready
        if (!connection.qrCode) {
          // Set no-cache headers
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
          res.setHeader("Pragma", "no-cache");
          res.setHeader("Expires", "0");
          return res.status(404).json({ error: "No QR code available" });
        }

        // Generate QR code image
        const format = (req.query.format as string) || "json";

        if (format === "image") {
          // Return as PNG image
          const qrImage = await QRCode.toBuffer(connection.qrCode, {
            type: "png",
            width: 512,
            margin: 2,
          });

          res.setHeader("Content-Type", "image/png");
          res.send(qrImage);
        } else if (format === "svg") {
          // Return as SVG
          const qrSvg = await QRCode.toString(connection.qrCode, {
            type: "svg",
            width: 512,
          });

          res.setHeader("Content-Type", "image/svg+xml");
          res.send(qrSvg);
        } else {
          // Return as JSON with base64 image
          const qrDataUrl = await QRCode.toDataURL(connection.qrCode, {
            width: 512,
            margin: 2,
          });

          // Set no-cache headers to ensure fresh QR codes
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
          res.setHeader("Pragma", "no-cache");
          res.setHeader("Expires", "0");

          res.json({
            qrCode: connection.qrCode,
            qrDataUrl,
            format: "base64",
          });
        }
      } catch (error) {
        logger.error(
          { error, userId: req.params.userId },
          "Failed to get QR code",
        );
        return res.status(500).json({ error: "Failed to get QR code" });
      }
    },
  );

  /**
   * GET /sessions/:userId/status
   * Get connection status
   */
  router.get(
    "/sessions/:userId/status",
    async (req: AuthenticatedRequest, res: Response): Promise<any> => {
      try {
        const { userId } = req.params;
        const phoneNumber = req.query.phoneNumber as string;

        if (!phoneNumber) {
          return res.status(400).json({ error: "Phone number required" });
        }

        // Format the phone number for consistent lookup
        const formattedPhone = formatPhoneNumberSafe(phoneNumber);
        if (!formattedPhone) {
          return res.status(400).json({
            error: "Invalid phone number format",
          });
        }

        // Verify user access
        if (req.user!.userId !== userId) {
          return res.status(403).json({ error: "Forbidden" });
        }

        const connection = connectionPool.getConnection(userId, formattedPhone);

        if (!connection) {
          return res.json({
            status: "disconnected",
            phoneNumber: formattedPhone,
          });
        }

        const proxyInfo = proxyManager.getSessionInfo(userId, formattedPhone);

        res.json({
          status: connection.state.connection,
          phoneNumber: formattedPhone,
          instanceUrl: connection.instanceUrl,
          createdAt: connection.createdAt,
          lastActivity: connection.lastActivity,
          messageCount: connection.messageCount,
          hasQR: !!connection.qrCode,
          proxy: proxyInfo
            ? {
                sessionId: proxyInfo.sessionId,
                country: proxyInfo.country,
                rotationCount: proxyInfo.rotationCount,
              }
            : null,
        });
      } catch (error) {
        logger.error(
          { error, userId: req.params.userId },
          "Failed to get session status",
        );
        return res.status(500).json({ error: "Failed to get session status" });
      }
    },
  );

  /**
   * DELETE /sessions/:userId
   * Disconnect a WhatsApp session
   */
  router.delete(
    "/sessions/:userId",
    async (req: AuthenticatedRequest, res: Response): Promise<any> => {
      try {
        const { userId } = req.params;
        const phoneNumber = req.query.phoneNumber as string;

        if (!phoneNumber) {
          return res.status(400).json({ error: "Phone number required" });
        }

        // Format the phone number for consistent lookup
        const formattedPhone = formatPhoneNumberSafe(phoneNumber);
        if (!formattedPhone) {
          logger.warn(
            { userId, phoneNumber },
            "Invalid phone number format in DELETE request",
          );
          return res.status(400).json({
            error: "Invalid phone number format",
            message: "Please provide a valid phone number with country code",
          });
        }

        // Verify user access
        if (req.user!.userId !== userId) {
          return res.status(403).json({ error: "Forbidden" });
        }

        // Check reason to determine if this is permanent deletion or soft disconnect
        const reason = req.query.reason as string;
        const isPermanentDelete =
          reason === "user_initiated" || reason === "deleted";

        logger.info(
          {
            userId,
            original: phoneNumber,
            formatted: formattedPhone,
            reason,
            isPermanentDelete,
          },
          "Processing session deletion request",
        );

        // Pass reason to removeConnection so it can skip status updates for permanent deletions
        await connectionPool.removeConnection(
          userId,
          formattedPhone,
          false,
          reason,
        );
        await sessionManager.deleteSession(
          userId,
          formattedPhone,
          isPermanentDelete,
        );

        res.json({
          status: "disconnected",
          phoneNumber: formattedPhone,
          permanentDelete: isPermanentDelete,
        });
      } catch (error) {
        logger.error(
          { error, userId: req.params.userId },
          "Failed to disconnect session",
        );
        return res.status(500).json({ error: "Failed to disconnect session" });
      }
    },
  );

  // Reconnection endpoints
  if (reconnectionService) {
    /**
     * GET /sessions/can-reconnect
     * Check if a user can reconnect to their session
     */
    router.get(
      "/sessions/can-reconnect",
      async (req: AuthenticatedRequest, res: Response): Promise<any> => {
        try {
          const phoneNumber = req.query.phoneNumber as string;
          const userId = req.user!.userId;

          if (!phoneNumber) {
            return res.status(400).json({ error: "Phone number required" });
          }

          const result = await reconnectionService.canReconnect(
            userId,
            phoneNumber,
          );

          res.json(result);
        } catch (error) {
          logger.error(
            { error, userId: req.user?.userId },
            "Failed to check reconnection status",
          );
          return res
            .status(500)
            .json({ error: "Failed to check reconnection status" });
        }
      },
    );

    /**
     * POST /sessions/reconnect
     * Attempt to reconnect to an existing WhatsApp Web session
     */
    router.post(
      "/sessions/reconnect",
      async (req: AuthenticatedRequest, res: Response): Promise<any> => {
        try {
          const { phoneNumber, forceNew = false } = req.body;
          const userId = req.user!.userId;

          if (!phoneNumber) {
            return res.status(400).json({ error: "Phone number required" });
          }

          logger.info(
            { userId, phoneNumber, forceNew },
            "Reconnection attempt requested",
          );

          const result = await reconnectionService.reconnect(
            userId,
            phoneNumber,
            forceNew,
          );

          // Set appropriate HTTP status based on result
          let statusCode = 200;
          if (!result.success) {
            if (result.status === "rate_limited") {
              statusCode = 429; // Too Many Requests
            } else if (result.status === "session_not_found") {
              statusCode = 404; // Not Found
            } else if (result.status === "timeout") {
              statusCode = 408; // Request Timeout
            } else if (result.status === "connection_failed") {
              statusCode = 503; // Service Unavailable
            } else if (result.status === "needs_qr") {
              statusCode = 401; // Unauthorized - needs re-authentication
            } else {
              statusCode = 400; // Bad Request
            }
          }

          res.status(statusCode).json(result);
        } catch (error) {
          logger.error(
            { error, userId: req.user?.userId },
            "Failed to reconnect session",
          );
          return res.status(500).json({
            success: false,
            status: "failed",
            error: "Failed to reconnect session",
          });
        }
      },
    );

    /**
     * GET /sessions/reconnect-status
     * Get reconnection status for a specific phone number
     */
    router.get(
      "/sessions/reconnect-status",
      async (req: AuthenticatedRequest, res: Response): Promise<any> => {
        try {
          const phoneNumber = req.query.phoneNumber as string;
          const userId = req.user!.userId;

          if (!phoneNumber) {
            return res.status(400).json({ error: "Phone number required" });
          }

          // Check if there's an active connection
          const existingConnection = connectionPool.getConnection(
            userId,
            phoneNumber,
          );

          if (existingConnection) {
            return res.json({
              status: "connected",
              phoneNumber,
              connectionInfo: {
                createdAt: existingConnection.createdAt,
                lastActivity: existingConnection.lastActivity,
                messageCount: existingConnection.messageCount,
                instanceUrl: existingConnection.instanceUrl,
              },
            });
          }

          // Check if session exists
          const sessionExists = await sessionManager.sessionExists(
            userId,
            phoneNumber,
          );

          if (sessionExists) {
            return res.json({
              status: "session_available",
              phoneNumber,
              canReconnect: true,
            });
          }

          return res.json({
            status: "no_session",
            phoneNumber,
            canReconnect: false,
          });
        } catch (error) {
          logger.error(
            { error, userId: req.user?.userId },
            "Failed to get reconnection status",
          );
          return res
            .status(500)
            .json({ error: "Failed to get reconnection status" });
        }
      },
    );

    /**
     * GET /sessions/reconnection-stats
     * Get reconnection statistics (for monitoring/debugging)
     */
    router.get(
      "/sessions/reconnection-stats",
      async (_req: AuthenticatedRequest, res: Response): Promise<any> => {
        try {
          const stats = reconnectionService.getStats();

          res.json({
            ...stats,
            timestamp: new Date().toISOString(),
          });
        } catch (error) {
          logger.error({ error }, "Failed to get reconnection stats");
          return res
            .status(500)
            .json({ error: "Failed to get reconnection stats" });
        }
      },
    );
  }

  /**
   * POST /messages/check-limits
   * Check if message can be sent (rate limits)
   */
  router.post(
    "/messages/check-limits",
    async (req: AuthenticatedRequest, res: Response): Promise<any> => {
      try {
        const { phoneNumber, toNumber } = req.body;
        const userId = req.user!.userId;

        if (!phoneNumber || !toNumber) {
          return res.status(400).json({
            error: "Missing required fields",
            required: ["phoneNumber", "toNumber"],
          });
        }

        // Check limits
        const limitCheck = await limitChecker.checkLimits(
          userId,
          phoneNumber,
          toNumber,
        );

        res.json({
          allowed: limitCheck.allowed,
          isNewContact: limitCheck.isNewContact,
          delayMs: limitCheck.delayMs,
          usage: limitCheck.usage,
          unlimited: limitCheck.unlimited,
          error: limitCheck.error,
        });
      } catch (error) {
        logger.error(
          { error, userId: req.user?.userId },
          "Failed to check limits",
        );
        return res.status(500).json({ error: "Failed to check limits" });
      }
    },
  );

  /**
   * POST /messages/send
   * Send a WhatsApp message
   */
  router.post(
    "/messages/send",
    async (req: AuthenticatedRequest, res: Response): Promise<any> => {
      const requestStart = Date.now();
      const correlationId = (req as any).correlationId || `msg_${Date.now()}`;

      try {
        const { phoneNumber, toNumber, message, media } = req.body;
        const userId = req.user!.userId;

        // Log incoming message request with sanitized data
        logger.info(
          {
            correlationId,
            userId,
            fromNumber: phoneNumber,
            toNumber: toNumber,
            body: message || "[No message]",
            hasMessage: !!message,
            messageLength: message?.length,
            hasMedia: !!media,
            mediaType: media?.type,
            mediaUrl: media?.url ? "provided" : "none",
          },
          "Message send request received",
        );

        if (!phoneNumber || !toNumber || (!message && !media)) {
          return res.status(400).json({
            error: "Missing required fields",
            required: ["phoneNumber", "toNumber", "message or media"],
          });
        }

        // Format both phone numbers
        const formattedPhone = formatPhoneNumberSafe(phoneNumber);
        const formattedToNumber = formatPhoneNumberSafe(toNumber);

        if (!formattedPhone || !formattedToNumber) {
          return res.status(400).json({
            error: "Invalid phone number format",
            message: "Please provide valid phone numbers with country codes",
          });
        }

        // Check WhatsApp Web limits before sending
        const limitCheckStart = Date.now();
        const limitCheck = await limitChecker.checkLimits(
          userId,
          formattedPhone,
          formattedToNumber,
        );

        logger.debug(
          {
            correlationId,
            userId,
            limitCheckDuration: Date.now() - limitCheckStart,
            allowed: limitCheck.allowed,
            isNewContact: limitCheck.isNewContact,
            delayMs: limitCheck.delayMs,
            dailyUsage: limitCheck.usage,
          },
          "Rate limit check completed",
        );

        if (!limitCheck.allowed) {
          logger.warn(
            { userId, phoneNumber, toNumber, error: limitCheck.error },
            "Message blocked by limits",
          );
          return res.status(429).json({
            error: "Rate limit exceeded",
            message: limitCheck.error,
            usage: limitCheck.usage,
            retryAfter: "tomorrow",
          });
        }

        // Delay functionality removed - messages now send immediately
        logger.info(
          {
            correlationId,
            isNewContact: limitCheck.isNewContact,
          },
          "Message ready to send immediately",
        );

        // Build message content
        let content: WAMessageContent;
        let mediaUrl = null;

        if (media) {
          // Handle media message

          // Check if we need to upload media first
          if (media.buffer && !media.url) {
            try {
              // Upload media to Cloud Storage
              const mediaService = connectionPool.getMediaService();

              // Convert base64 to buffer if needed
              let buffer: Buffer;
              if (typeof media.buffer === "string") {
                // Assume base64 encoded
                buffer = Buffer.from(media.buffer, "base64");
              } else if (Buffer.isBuffer(media.buffer)) {
                buffer = media.buffer;
              } else {
                throw new Error("Invalid buffer format");
              }

              // Determine mimetype from media type
              let mimetype = media.mimetype;
              if (!mimetype) {
                switch (media.type) {
                  case "image":
                    mimetype = "image/jpeg";
                    break;
                  case "video":
                    mimetype = "video/mp4";
                    break;
                  case "audio":
                    mimetype = "audio/ogg";
                    break;
                  case "document":
                    mimetype = "application/octet-stream";
                    break;
                  default:
                    mimetype = "application/octet-stream";
                }
              }

              const uploadResult = await mediaService.uploadMedia(
                {
                  buffer,
                  mimetype,
                  size: buffer.length,
                  originalname: media.fileName || `media_${Date.now()}`,
                },
                userId,
                formattedPhone,
              );

              mediaUrl = uploadResult.url;

              logger.info(
                {
                  correlationId,
                  userId,
                  mediaType: media.type,
                  mediaSize: buffer.length,
                  uploadedUrl: mediaUrl,
                },
                "Media uploaded successfully for sending",
              );
            } catch (error) {
              logger.error(
                {
                  correlationId,
                  userId,
                  error,
                  mediaType: media.type,
                },
                "Failed to upload media for sending",
              );
              return res.status(500).json({
                error: "Failed to upload media",
                details:
                  error instanceof Error ? error.message : "Unknown error",
              });
            }
          } else if (media.url) {
            // Use provided URL
            mediaUrl = media.url;
          } else {
            return res.status(400).json({
              error: "Media must include either 'url' or 'buffer' field",
            });
          }

          // Build WhatsApp message content with media URL
          if (media.type === "image") {
            content = {
              image: { url: mediaUrl },
              caption: message,
            } as WAMessageContent;
          } else if (media.type === "video") {
            content = {
              video: { url: mediaUrl },
              caption: message,
            } as WAMessageContent;
          } else if (media.type === "document") {
            content = {
              document: { url: mediaUrl },
              fileName: media.fileName || "document",
              caption: message,
            } as WAMessageContent;
          } else if (media.type === "audio") {
            content = {
              audio: { url: mediaUrl },
              ptt: media.voiceNote || false,
            } as WAMessageContent;
          } else {
            return res.status(400).json({ error: "Unsupported media type" });
          }
        } else {
          // Text message
          content = { text: message } as WAMessageContent;
        }

        // Send message using formatted phone numbers
        const sendStart = Date.now();
        logger.debug(
          {
            correlationId,
            userId,
            contentType: (content as any).text
              ? "text"
              : Object.keys(content)[0],
            operation: "send_to_whatsapp",
          },
          "Sending message to WhatsApp",
        );

        const messageKey = await connectionPool.sendMessage(
          userId,
          formattedPhone,
          formattedToNumber,
          content,
        );

        const sendDuration = Date.now() - sendStart;

        if (!messageKey) {
          logger.error(
            {
              correlationId,
              userId,
              phoneNumber: formattedPhone,
              toNumber: formattedToNumber,
              body: message || "[No message]",
              duration: Date.now() - requestStart,
              error: "no_message_key_returned",
            },
            "Failed to send message - no key returned",
          );
          return res.status(500).json({ error: "Failed to send message" });
        }

        // Log successful message send with all metrics
        const totalDuration = Date.now() - requestStart;
        logger.info(
          {
            correlationId,
            userId,
            messageId: messageKey.id,
            fromNumber: formattedPhone,
            toNumber: formattedToNumber,
            body: message || "[No message]",
            contentType: (content as any).text
              ? "text"
              : Object.keys(content)[0],
            mediaProcessed: !!media,
            sendDuration,
            totalDuration,
            creditsUsed:
              (limitCheck.usage as any)?.messagesUsedToday ||
              limitCheck.usage?.used,
            isNewContact: limitCheck.isNewContact,
            timestamp: new Date().toISOString(),
          },
          "Message sent successfully",
        );

        res.json({
          success: true,
          messageId: messageKey.id,
          timestamp: new Date().toISOString(),
          correlationId,
        });
      } catch (error: any) {
        const errorDuration = Date.now() - requestStart;
        logger.error(
          {
            correlationId,
            error: error.message,
            errorStack: error.stack,
            userId: req.user?.userId,
            duration: errorDuration,
            phoneNumber: req.body.phoneNumber,
            toNumber: req.body.toNumber,
            body: req.body.message || "[No message]",
          },
          "Failed to send message",
        );
        return res.status(500).json({
          error: "Failed to send message",
          correlationId,
          message:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    },
  );

  /**
   * POST /messages/typing
   * Send typing indicator or presence subscription
   */
  router.post(
    "/messages/typing",
    async (req: AuthenticatedRequest, res: Response): Promise<any> => {
      try {
        const { phoneNumber, toNumber, isTyping, action } = req.body;
        const userId = req.user!.userId;

        const connection = connectionPool.getConnection(userId, phoneNumber);

        if (!connection || connection.state.connection !== "open") {
          return res.status(404).json({ error: "No active connection" });
        }

        const jid = `${toNumber.replace(/\D/g, "")}@s.whatsapp.net`;

        // Handle new action-based approach
        if (action) {
          if (action === "subscribe") {
            // Subscribe to presence updates for this contact
            await connection.socket.presenceSubscribe(jid);
            logger.debug(
              { userId, phoneNumber, toNumber },
              "Subscribed to presence updates",
            );
          } else if (action === "composing") {
            await connection.socket.sendPresenceUpdate("composing", jid);
            logger.debug(
              { userId, phoneNumber, toNumber },
              "Started typing indicator",
            );
          } else if (action === "paused") {
            await connection.socket.sendPresenceUpdate("paused", jid);
            logger.debug(
              { userId, phoneNumber, toNumber },
              "Stopped typing indicator",
            );
          } else {
            return res.status(400).json({
              error:
                "Invalid action. Must be 'subscribe', 'composing', or 'paused'",
            });
          }
        } else {
          // Fallback to legacy isTyping parameter for backward compatibility
          if (isTyping) {
            await connection.socket.sendPresenceUpdate("composing", jid);
          } else {
            await connection.socket.sendPresenceUpdate("paused", jid);
          }
        }

        res.json({ success: true });
      } catch (error) {
        logger.error(
          { error, userId: req.user?.userId },
          "Failed to send typing indicator",
        );
        return res
          .status(500)
          .json({ error: "Failed to send typing indicator" });
      }
    },
  );

  /**
   * POST /messages/read
   * Mark messages as read
   */
  router.post(
    "/messages/read",
    async (req: AuthenticatedRequest, res: Response): Promise<any> => {
      try {
        const { phoneNumber, messageIds, chatJid } = req.body;
        const userId = req.user!.userId;

        const connection = connectionPool.getConnection(userId, phoneNumber);

        if (!connection || connection.state.connection !== "open") {
          return res.status(404).json({ error: "No active connection" });
        }

        // Mark as read
        await connection.socket.readMessages(
          messageIds.map((id: string) => ({
            remoteJid: chatJid,
            id,
            participant: undefined,
          })),
        );

        res.json({ success: true });
      } catch (error) {
        logger.error(
          { error, userId: req.user?.userId },
          "Failed to mark messages as read",
        );
        return res
          .status(500)
          .json({ error: "Failed to mark messages as read" });
      }
    },
  );

  /**
   * GET /proxy/locations
   * Get available proxy locations
   */
  router.get(
    "/proxy/locations",
    async (req: AuthenticatedRequest, res: Response): Promise<any> => {
      try {
        const locations = proxyManager.getAvailableLocations();

        // Try to detect user's country from IP
        let userCountry = "us"; // Default
        const userIp = (req.headers["x-forwarded-for"] as string) || req.ip;

        if (userIp) {
          try {
            // Fast-geoip is not available - using default country
            // TODO: Implement IP geolocation using an alternative library
            userCountry = "us";
          } catch (e) {
            logger.debug({ error: e }, "Failed to detect user country from IP");
          }
        }

        const nearestLocation = proxyManager.findNearestLocation(userCountry);

        res.json({
          locations,
          recommendedLocation: userCountry,
          nearestAvailable: nearestLocation,
          userDetectedCountry: userCountry,
        });
      } catch (error) {
        logger.error({ error }, "Failed to get proxy locations");
        return res.status(500).json({ error: "Failed to get proxy locations" });
      }
    },
  );

  /**
   * GET /metrics
   * Get service metrics
   */
  router.get("/metrics", async (_req: AuthenticatedRequest, res: Response) => {
    const poolMetrics = connectionPool.getMetrics();
    const sessionMetrics = sessionManager.getMetrics();
    const proxyMetrics = proxyManager.getMetrics();

    res.json({
      pool: poolMetrics,
      sessions: sessionMetrics,
      proxy: proxyMetrics,
      system: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        cpu: process.cpuUsage(),
      },
    });
  });

  /**
   * POST /connections/recover
   * Manually trigger connection recovery
   */
  router.post(
    "/connections/recover",
    async (req: AuthenticatedRequest, res: Response): Promise<any> => {
      try {
        logger.info(
          { userId: req.user?.userId },
          "Manual connection recovery requested",
        );

        await connectionPool.initializeRecovery();

        return res.json({
          success: true,
          message: "Connection recovery initiated",
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        logger.error(
          { error, userId: req.user?.userId },
          "Failed to initiate recovery",
        );
        return res.status(500).json({
          error: "Failed to initiate recovery",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * GET /connections/status
   * Get detailed connection status including recovery state
   */
  router.get(
    "/connections/status",
    async (req: AuthenticatedRequest, res: Response): Promise<any> => {
      try {
        const poolMetrics = connectionPool.getMetrics();

        let stateMetrics = null;
        let activeConnections: any[] = [];

        if (connectionStateManager) {
          stateMetrics = await connectionStateManager.getMetrics();
          activeConnections =
            await connectionStateManager.getActiveConnections();
        }

        return res.json({
          pool: poolMetrics,
          states: stateMetrics,
          activeConnections: activeConnections.map((conn) => ({
            userId: conn.userId,
            phoneNumber: conn.phoneNumber,
            status: conn.status,
            lastActivity: conn.lastActivity,
            lastHeartbeat: conn.lastHeartbeat,
            syncCompleted: conn.syncCompleted,
            messageCount: conn.messageCount,
          })),
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        logger.error(
          { error, userId: req.user?.userId },
          "Failed to get connection status",
        );
        return res.status(500).json({
          error: "Failed to get connection status",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * GET /proxy/status
   * Get proxy configuration and metrics
   */
  router.get(
    "/proxy/status",
    async (_req: AuthenticatedRequest, res: Response): Promise<any> => {
      try {
        const metrics = proxyManager.getMetrics();
        const proxyType = "isp";
        const useProxy = process.env.USE_PROXY !== "false";

        res.json({
          enabled: useProxy,
          type: proxyType,
          metrics,
          config: {
            host: process.env.BRIGHT_DATA_HOST,
            port: process.env.BRIGHT_DATA_PORT,
            zone: process.env.BRIGHT_DATA_ZONE,
          },
        });
      } catch (error) {
        logger.error({ error }, "Failed to get proxy status");
        res.status(500).json({ error: "Failed to get proxy status" });
      }
    },
  );

  /**
   * POST /proxy/test
   * Test proxy connection
   */
  router.post(
    "/proxy/test",
    async (req: AuthenticatedRequest, res: Response): Promise<any> => {
      try {
        const { phoneNumber } = req.body;
        const userId = req.user!.userId;

        const testResult = await proxyManager.testProxyConnection(
          userId,
          phoneNumber || "test_connection",
        );

        res.json({
          success: testResult,
          message: testResult
            ? "Proxy connection successful"
            : "Proxy connection failed - check configuration",
        });
      } catch (error) {
        logger.error({ error }, "Proxy test failed");
        res.status(500).json({
          success: false,
          error: "Proxy test failed",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * POST /proxy/rotate
   * Force proxy rotation for a phone number
   */
  router.post(
    "/proxy/rotate",
    async (req: AuthenticatedRequest, res: Response): Promise<any> => {
      try {
        const { phoneNumber } = req.body;
        const userId = req.user!.userId;

        if (!phoneNumber) {
          return res.status(400).json({ error: "Phone number required" });
        }

        const formattedPhone = formatPhoneNumberSafe(phoneNumber);
        if (!formattedPhone) {
          return res.status(400).json({ error: "Invalid phone number format" });
        }

        const newConfig = await proxyManager.rotateProxy(
          userId,
          formattedPhone,
        );

        res.json({
          success: true,
          message: "Proxy rotated successfully",
          sessionId: newConfig?.sessionId,
        });
      } catch (error) {
        logger.error({ error }, "Failed to rotate proxy");
        res.status(500).json({
          error: "Failed to rotate proxy",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  return router;
}
