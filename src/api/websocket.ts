import { Server as SocketServer, Socket } from "socket.io";
import { ConnectionPool } from "../core/ConnectionPool";
import { SessionManager } from "../core/SessionManager";
import pino from "pino";
import { formatPhoneNumberSafe } from "../utils/phoneNumber";

const logger = pino({ name: "WebSocket" });

interface AuthenticatedSocket extends Socket {
  userId?: string;
  phoneNumber?: string;
}

export function createWebSocketHandlers(
  io: SocketServer,
  connectionPool: ConnectionPool,
  _sessionManager: SessionManager,
) {
  // Authentication middleware
  io.use((socket: AuthenticatedSocket, next) => {
    const token = socket.handshake.auth.token;
    const userId = socket.handshake.auth.userId;
    let phoneNumber = socket.handshake.auth.phoneNumber;

    // Simple token validation (in production, use JWT or similar)
    if (!token || token !== process.env.WS_TOKEN) {
      return next(new Error("Authentication failed"));
    }

    if (!userId) {
      return next(new Error("User ID required"));
    }

    // Format phone number if provided
    if (phoneNumber) {
      const formatted = formatPhoneNumberSafe(phoneNumber);
      if (formatted) {
        phoneNumber = formatted;
      }
    }

    socket.userId = userId;
    socket.phoneNumber = phoneNumber;

    logger.info({ userId, phoneNumber }, "WebSocket client authenticated");
    next();
  });

  io.on("connection", (socket: AuthenticatedSocket) => {
    const { userId, phoneNumber } = socket;

    logger.info(
      { userId, phoneNumber, socketId: socket.id },
      "WebSocket client connected",
    );

    // Join user-specific room
    if (userId) {
      socket.join(`user:${userId}`);

      // Join phone-specific room if provided
      if (phoneNumber) {
        socket.join(`session:${userId}:${phoneNumber}`);
      }
    }

    /**
     * Subscribe to connection updates
     */
    socket.on("subscribe:connection", (data) => {
      const { phoneNumber } = data;

      // Format phone number properly
      const phone = formatPhoneNumberSafe(phoneNumber);
      if (!phone) {
        logger.warn(
          { userId, phoneNumber, socketId: socket.id },
          "Invalid phone number format",
        );
        socket.emit("error", { message: "Invalid phone number format" });
        return;
      }

      logger.info(
        {
          userId,
          phoneNumber: phone,
          socketId: socket.id,
        },
        "Client subscribing to connection updates",
      );

      if (phone && userId) {
        const roomName = `session:${userId}:${phone}`;
        socket.join(roomName);

        logger.info(
          {
            userId,
            phoneNumber: phone,
            roomName,
            roomsJoined: Array.from(socket.rooms),
          },
          "Client joined session room",
        );

        // Add a small delay to ensure client is ready to receive
        setTimeout(() => {
          // Send current connection status
          const connection = connectionPool.getConnection(userId, phone);

          const statusData = {
            phoneNumber: phone,
            status: connection ? connection.state.connection : "disconnected",
            hasQR: connection ? !!connection.qrCode : false,
          };

          socket.emit("connection:status", statusData);

          // If QR code exists, send it immediately
          if (connection && connection.qrCode) {
            logger.info(
              {
                userId,
                phoneNumber: phone,
                qrLength: connection.qrCode.length,
                socketId: socket.id,
              },
              "Sending existing QR code to newly subscribed client",
            );

            socket.emit("qr:code", {
              phoneNumber: phone,
              qr: connection.qrCode,
            });

            // Also emit to the room as backup
            socket.to(roomName).emit("qr:code", {
              phoneNumber: phone,
              qr: connection.qrCode,
            });
          } else {
            logger.info(
              {
                userId,
                phoneNumber: phone,
                hasConnection: !!connection,
                connectionState: connection?.state?.connection,
                socketId: socket.id,
              },
              "No QR code available for newly subscribed client",
            );
          }
        }, 100); // 100ms delay to ensure socket is fully ready
      }
    });

    /**
     * Unsubscribe from connection updates
     */
    socket.on("unsubscribe:connection", (data) => {
      const { phoneNumber: phone } = data;

      if (phone && userId) {
        socket.leave(`session:${userId}:${phone}`);
      }
    });

    /**
     * Request QR code
     */
    socket.on("qr:request", async (data) => {
      const { phoneNumber: phone } = data;

      if (!phone || !userId) {
        socket.emit("error", { message: "Invalid request" });
        return;
      }

      const connection = connectionPool.getConnection(userId, phone);

      if (connection && connection.qrCode) {
        socket.emit("qr:code", {
          phoneNumber: phone,
          qr: connection.qrCode,
        });
      } else {
        socket.emit("qr:unavailable", {
          phoneNumber: phone,
          message: "QR code not available",
        });
      }
    });

    /**
     * Send message via WebSocket
     */
    socket.on("message:send", async (data) => {
      const { phoneNumber: phone, toNumber, message, media } = data;
      const wsMessageId = `ws_msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const startTime = Date.now();

      // Log WebSocket message request
      logger.info(
        {
          wsMessageId,
          userId,
          socketId: socket.id,
          fromNumber: phone,
          toNumber: toNumber,
          body: message || "[No message]",
          hasMessage: !!message,
          messageLength: message?.length,
          hasMedia: !!media,
          mediaType: media?.type,
          event: "websocket_message_received",
        },
        "WebSocket message send request received",
      );

      if (!phone || !toNumber || !message || !userId) {
        logger.warn(
          {
            wsMessageId,
            userId,
            socketId: socket.id,
            missingFields: {
              phone: !phone,
              toNumber: !toNumber,
              message: !message,
              userId: !userId,
            },
          },
          "Invalid WebSocket message data",
        );
        socket.emit("error", { message: "Invalid message data" });
        return;
      }

      try {
        let content: any;

        if (media) {
          // Handle media
          content = {
            [media.type]: { url: media.url },
            caption: message,
          };
          logger.debug(
            {
              wsMessageId,
              mediaType: media.type,
              hasCaption: !!message,
            },
            "Preparing media message",
          );
        } else {
          content = { text: message };
        }

        const sendStart = Date.now();
        logger.debug(
          {
            wsMessageId,
            userId,
            contentType: content.text ? "text" : Object.keys(content)[0],
          },
          "Sending message via connection pool",
        );

        const messageKey = await connectionPool.sendMessage(
          userId,
          phone,
          toNumber,
          content,
        );

        const sendDuration = Date.now() - sendStart;

        if (messageKey) {
          const totalDuration = Date.now() - startTime;

          logger.info(
            {
              wsMessageId,
              userId,
              socketId: socket.id,
              whatsappMessageId: messageKey.id,
              toNumber: toNumber,
              body: message || "[No message]",
              sendDuration,
              totalDuration,
              success: true,
              event: "websocket_message_sent",
            },
            "WebSocket message sent successfully",
          );

          socket.emit("message:sent", {
            messageId: messageKey.id,
            toNumber,
            timestamp: new Date().toISOString(),
            wsMessageId,
          });
        } else {
          logger.error(
            {
              wsMessageId,
              userId,
              socketId: socket.id,
              toNumber: toNumber,
              body: message || "[No message]",
              duration: Date.now() - startTime,
              error: "no_message_key",
            },
            "WebSocket message failed - no key returned",
          );

          socket.emit("message:failed", {
            toNumber,
            error: "Failed to send message",
            wsMessageId,
          });
        }
      } catch (error: any) {
        const errorDuration = Date.now() - startTime;

        logger.error(
          {
            wsMessageId,
            error: error.message,
            errorStack: error.stack,
            userId,
            socketId: socket.id,
            phone: phone,
            toNumber: toNumber,
            body: message || "[No message]",
            duration: errorDuration,
            event: "websocket_message_error",
          },
          "Failed to send message via WebSocket",
        );

        socket.emit("message:failed", {
          toNumber,
          error: "Failed to send message",
          wsMessageId,
          errorMessage:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    /**
     * Send typing indicator
     */
    socket.on("typing:start", async (data) => {
      const { phoneNumber: phone, toNumber } = data;

      if (!phone || !toNumber || !userId) return;

      const connection = connectionPool.getConnection(userId, phone);

      if (connection && connection.state.connection === "open") {
        const jid = `${toNumber.replace(/\D/g, "")}@s.whatsapp.net`;
        await connection.socket.sendPresenceUpdate("composing", jid);
      }
    });

    socket.on("typing:stop", async (data) => {
      const { phoneNumber: phone, toNumber } = data;

      if (!phone || !toNumber || !userId) return;

      const connection = connectionPool.getConnection(userId, phone);

      if (connection && connection.state.connection === "open") {
        const jid = `${toNumber.replace(/\D/g, "")}@s.whatsapp.net`;
        await connection.socket.sendPresenceUpdate("paused", jid);
      }
    });

    /**
     * Mark messages as read
     */
    socket.on("messages:read", async (data) => {
      const { phoneNumber: phone, messageIds, chatJid } = data;

      if (!phone || !messageIds || !chatJid || !userId) return;

      const connection = connectionPool.getConnection(userId, phone);

      if (connection && connection.state.connection === "open") {
        await connection.socket.readMessages(
          messageIds.map((id: string) => ({
            remoteJid: chatJid,
            id,
            participant: undefined,
          })),
        );

        socket.emit("messages:marked_read", {
          messageIds,
          chatJid,
        });
      }
    });

    /**
     * Handle disconnection
     */
    socket.on("disconnect", () => {
      logger.info(
        { userId, socketId: socket.id },
        "WebSocket client disconnected",
      );
    });

    /**
     * Error handling
     */
    socket.on("error", (error) => {
      logger.error({ error, userId, socketId: socket.id }, "WebSocket error");
    });
  });

  // Listen for connection pool events and broadcast to clients
  connectionPool.on("qr-generated", (data: any) => {
    const { userId, phoneNumber, qr } = data;

    logger.info(
      {
        userId,
        phoneNumber: phoneNumber,
        qrLength: qr?.length,
        roomName: `session:${userId}:${phoneNumber}`,
        event: "qr_code_broadcast",
        timestamp: new Date().toISOString(),
      },
      "Broadcasting QR code to WebSocket clients",
    );

    // Emit to specific session room
    const roomClients = io.sockets.adapter.rooms.get(
      `session:${userId}:${phoneNumber}`,
    );
    const clientCount = roomClients ? roomClients.size : 0;

    logger.info(
      {
        userId,
        phoneNumber,
        clientCount,
        rooms: Array.from(io.sockets.adapter.rooms.keys()),
      },
      "Room status before QR broadcast",
    );

    io.to(`session:${userId}:${phoneNumber}`).emit("qr:code", {
      phoneNumber,
      qr,
    });

    // Also emit to user room as fallback
    io.to(`user:${userId}`).emit("qr:code", {
      phoneNumber,
      qr,
    });
  });

  connectionPool.on("connection-update", (data: any) => {
    const { userId, phoneNumber, status } = data;

    logger.debug(
      {
        userId,
        phoneNumber: phoneNumber,
        status,
        event: "connection_status_update",
        timestamp: new Date().toISOString(),
      },
      "Broadcasting connection status update",
    );

    // Emit to specific session room
    io.to(`session:${userId}:${phoneNumber}`).emit("connection:status", {
      phoneNumber,
      status,
    });

    // Also emit to user room for general updates
    io.to(`user:${userId}`).emit("session:update", {
      phoneNumber,
      status,
    });

    // Auto-subscribe clients to session updates when connection becomes active
    if (status === "connected" || status === "connecting") {
      logger.info(
        {
          userId,
          phoneNumber,
          status,
          event: "auto_subscribe_clients",
        },
        "Auto-subscribing clients to session updates",
      );

      // Get all sockets in the user room and auto-subscribe them to session updates
      const userRoomSockets = io.sockets.adapter.rooms.get(`user:${userId}`);
      if (userRoomSockets) {
        userRoomSockets.forEach((socketId) => {
          const socket = io.sockets.sockets.get(
            socketId,
          ) as AuthenticatedSocket;
          if (socket && socket.userId === userId) {
            // Auto-join the session room for sync updates
            const sessionRoomName = `session:${userId}:${phoneNumber}`;
            socket.join(sessionRoomName);

            logger.debug(
              {
                userId,
                phoneNumber,
                socketId: socket.id,
                sessionRoomName,
                roomsJoined: Array.from(socket.rooms),
              },
              "Auto-subscribed client to session room",
            );

            // Send current connection status to newly subscribed client
            socket.emit("connection:status", {
              phoneNumber,
              status,
              hasQR: false, // No QR needed since we're connected
            });
          }
        });
      }
    }
  });

  connectionPool.on("message-received", (data: any) => {
    const { userId, phoneNumber, message } = data;

    // Extract message text for logging
    const messageText =
      message?.message?.conversation ||
      message?.message?.extendedTextMessage?.text ||
      message?.message?.imageMessage?.caption ||
      message?.message?.videoMessage?.caption ||
      "[Media/Other Message]";

    logger.info(
      {
        userId,
        phoneNumber: phoneNumber,
        messageId: message?.key?.id,
        fromNumber: message?.key?.remoteJid,
        body: messageText,
        messageType: message?.message?.conversation ? "text" : "other",
        event: "message_received_broadcast",
        timestamp: new Date().toISOString(),
      },
      "Broadcasting received message to clients",
    );

    // Emit to specific session room
    io.to(`session:${userId}:${phoneNumber}`).emit("message:received", {
      phoneNumber,
      message,
    });
  });

  connectionPool.on("message-status", (data: any) => {
    const { userId, phoneNumber, messageId, status } = data;

    // Emit to specific session room
    io.to(`session:${userId}:${phoneNumber}`).emit("message:status", {
      phoneNumber,
      messageId,
      status,
    });
  });

  connectionPool.on("typing-indicator", (data: any) => {
    const { userId, phoneNumber, chatId, isTyping } = data;

    // Emit to specific session room
    io.to(`session:${userId}:${phoneNumber}`).emit("typing:indicator", {
      phoneNumber,
      chatId,
      isTyping,
    });
  });

  connectionPool.on("presence-update", (data: any) => {
    const { userId, phoneNumber, jid, presence } = data;

    // Emit to specific session room
    io.to(`session:${userId}:${phoneNumber}`).emit("presence:update", {
      phoneNumber,
      jid,
      presence,
    });
  });

  // History sync events
  connectionPool.on("history-synced", (data: any) => {
    const { userId, phoneNumber, contacts, messages } = data;

    logger.info(
      { userId, phoneNumber, contacts, messages },
      "History sync completed",
    );

    // Emit to specific session room
    io.to(`session:${userId}:${phoneNumber}`).emit("sync:completed", {
      phoneNumber,
      contacts,
      messages,
    });
  });

  connectionPool.on("contacts-synced", (data: any) => {
    const { userId, phoneNumber, count } = data;

    // Emit progress update
    io.to(`session:${userId}:${phoneNumber}`).emit("sync:contacts", {
      phoneNumber,
      count,
    });
  });

  connectionPool.on("messages-synced", (data: any) => {
    const { userId, phoneNumber, count } = data;

    // Emit progress update
    io.to(`session:${userId}:${phoneNumber}`).emit("sync:messages", {
      phoneNumber,
      count,
    });
  });

  connectionPool.on("message-stored", (data: any) => {
    const { userId, phoneNumber, messageId, fromNumber } = data;

    // Emit real-time message update
    io.to(`session:${userId}:${phoneNumber}`).emit("message:new", {
      phoneNumber,
      messageId,
      fromNumber,
    });
  });

  // Sync started event - for UI to show "Syncing data..."
  connectionPool.on("sync:started", (data: any) => {
    const { userId, phoneNumber } = data;

    logger.info({ userId, phoneNumber }, "Sync started, notifying clients");

    // Emit to specific session room
    io.to(`session:${userId}:${phoneNumber}`).emit("sync:started", {
      phoneNumber,
      timestamp: new Date().toISOString(),
    });
  });

  // Sync progress events
  connectionPool.on("sync:progress", (data: any) => {
    const { userId, phoneNumber, type, count } = data;

    logger.info({ userId, phoneNumber, type, count }, "Sync progress update");

    // Emit to specific session room
    io.to(`session:${userId}:${phoneNumber}`).emit("sync:progress", {
      phoneNumber,
      type,
      count,
      timestamp: new Date().toISOString(),
    });
  });

  logger.info("WebSocket handlers initialized");
}
