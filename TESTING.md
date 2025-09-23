# WhatsApp Web Integration Testing Guide

## Quick Start

### 1. Start the Backend Service

```bash
cd whatsapp-web-service
npm install        # Install dependencies if not already done
npm run dev       # Start the service with hot reload
```

The service will start on http://localhost:8090

### 2. Test the Integration

In a new terminal:

```bash
cd whatsapp-web-service
node test-integration.js
```

This will:

1. Initialize a WhatsApp Web session
2. Connect via WebSocket
3. Wait for QR code
4. Monitor connection status

### 3. Start the Flutter App

In another terminal:

```bash
cd WhatzAI
flutter run -d chrome
```

Then in the app:

1. Navigate to WhatsApp Web settings
2. Click "Connect WhatsApp"
3. Enter a phone number (e.g., +1234567890)
4. The QR code should appear automatically via WebSocket

## Architecture Overview

```
Flutter App (Frontend)
    ↓
Socket.io WebSocket (Port 8090)
    ↓
WhatsApp Web Service (Backend)
    ↓
Baileys Socket
    ↓
WhatsApp Servers
```

## Key Improvements Made

### Backend (whatsapp-web-service)

1. **QR Code Event Timing**
   - QR events are now emitted immediately when received from Baileys
   - Added 60-second expiry (more realistic than 20 seconds)
   - Events are sent before Firestore updates to reduce latency

2. **Enhanced Logging**
   - Comprehensive logging of all WebSocket events
   - Room membership tracking
   - Connection state logging

3. **Immediate QR Delivery**
   - When client subscribes, existing QR is sent immediately
   - Fallback to user room for broader delivery

### Frontend (WhatzAI)

1. **Eliminated Duplicate Requests**
   - Removed redundant HTTP polling when WebSocket is connected
   - WebSocket is the primary channel for real-time updates

2. **Auto-Reconnection**
   - Exponential backoff (2s, 4s, 8s, 16s, 32s)
   - Maximum 5 reconnection attempts
   - Automatic recovery from disconnections

3. **Better Error Handling**
   - Clear error states in UI
   - Debug logging for troubleshooting

## Troubleshooting

### QR Code Not Appearing

1. **Check Backend Logs**

   ```bash
   # Look for these key messages:
   "Connection update received" with hasQR: true
   "QR code received from Baileys"
   "Broadcasting QR code to WebSocket clients"
   ```

2. **Check Frontend Console**

   ```
   # In browser DevTools, look for:
   "WebSocket connected"
   "QR event received"
   ```

3. **Verify WebSocket Connection**
   - The test script will show if WebSocket connects properly
   - Check that the "Live" indicator appears in the QR modal

### Connection Issues

1. **Backend Not Starting**
   - Ensure port 8090 is free: `lsof -i :8090`
   - Check Node version: `node --version` (needs v20+)

2. **WebSocket Not Connecting**
   - Check CORS settings in .env (should be `*` for local dev)
   - Verify API_KEY matches between frontend and backend
   - Ensure no firewall blocking local connections

3. **Baileys Socket Issues**
   - Clear session data: `rm -rf whatsapp-web-service/sessions/*`
   - Try with a fresh phone number
   - Check Baileys version compatibility

## Environment Variables

Ensure `.env` file has:

```env
PORT=8090
NODE_ENV=development
CORS_ORIGIN=*
API_KEY=wws_local_dev_key_123
WS_TOKEN=wws_local_dev_key_123
LOG_LEVEL=debug
DISABLE_MEMORY_CHECK=true
```

## Testing Checklist

- [ ] Backend service starts without errors
- [ ] Test script connects successfully
- [ ] WebSocket connection established
- [ ] QR code is received via WebSocket
- [ ] QR code appears in Flutter app
- [ ] Scanning QR establishes WhatsApp connection
- [ ] Connection status updates to "connected"
- [ ] WebSocket auto-reconnects on disconnect

## Next Steps

Once basic connection works:

1. Test message sending/receiving
2. Test session persistence across restarts
3. Test multiple phone numbers
4. Test error recovery scenarios
5. Implement production security measures
