# Local Development with Flutter Emulator Mode

This guide explains how to run the WhatsApp Web service locally and connect it with the Flutter app using the emulator mode.

## Quick Start

### 1. Start the WhatsApp Web Service

```bash
# Navigate to WhatsApp Web service
cd whatsapp-web-service

# Copy local environment (proxy disabled)
cp .env.local .env

# Install dependencies (first time only)
npm install

# Start the development server
npm run dev
```

The server will start on `http://localhost:8090`

### 2. Enable Emulator Mode in Flutter App

1. Open the DM Champ app in your browser/device
2. Go to the Dashboard
3. Look for the **"Use Emulator"** button (usually in dev/debug section)
4. Click it to enable emulator mode
5. The button will change to **"Use Live DB"** when emulator is active

### 3. Connect WhatsApp Web

1. Navigate to WhatsApp Web setup in the app
2. The app will automatically use `http://localhost:8080` instead of Firebase Functions
3. Select your location (proxy will be disabled in local mode)
4. Click "Connect WhatsApp"
5. Scan the QR code with your phone

## How It Works

When emulator mode is enabled (`FFAppState().isEmulatorRunning = true`):

- **WhatsApp Web QR Modal** uses direct HTTP calls to `localhost:8090`
- **Proxy is disabled** automatically when `USE_PROXY=false` in `.env`
- **Sessions are stored locally** in `./sessions` directory
- **No Firebase Functions** are called for WhatsApp Web operations

## API Endpoints (Local)

All endpoints use API key: `wws_local_dev_key_123`

```bash
# Health Check
GET http://localhost:8090/health

# Get Proxy Locations (returns mock data in local mode)
GET http://localhost:8090/api/proxy/locations

# Initialize Session
POST http://localhost:8090/api/sessions/initialize
Body: {
  "userId": "test-user",
  "phoneNumber": "+1234567890"
}

# Get QR Code
GET http://localhost:8090/api/sessions/test-user/qr?phoneNumber=+1234567890

# Check Status
GET http://localhost:8090/api/sessions/test-user/status?phoneNumber=+1234567890
```

## Environment Variables (.env.local)

```env
# Disable proxy for local development
USE_PROXY=false

# Local API key
API_KEY=wws_local_dev_key_123

# Firebase emulators (optional)
FIREBASE_AUTH_EMULATOR_HOST=localhost:9099
FIRESTORE_EMULATOR_HOST=localhost:8088

# Local session storage
SESSION_STORAGE_TYPE=local
SESSION_STORAGE_PATH=./sessions
```

## Troubleshooting

### Port Already in Use

```bash
# Find what's using port 8090
lsof -i :8090

# Or use a different port
PORT=8091 npm run dev
```

### Firebase Emulator Port Conflict

By default, Firebase Firestore emulator uses port 8080. That's why we use port 8090 for the WhatsApp Web service to avoid conflicts.

### CORS Issues

The service is configured to accept requests from:

- `http://localhost:3000` (default Flutter web)
- `http://localhost:*` (any localhost port)

Add more origins in `.env` if needed:

```env
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:4200
```

### Session Not Persisting

Check that `./sessions` directory exists and has write permissions:

```bash
mkdir -p sessions
chmod 755 sessions
```

### Can't Connect to WhatsApp

Without proxy, WhatsApp might show security warnings if:

- You're on a VPN
- Your IP location is unusual
- Multiple login attempts

Try:

1. Disable VPN
2. Wait a few minutes between attempts
3. Use your regular network

## Benefits of Local Development

✅ **No proxy costs** - Direct connection to WhatsApp
✅ **Faster development** - No network latency
✅ **Easy debugging** - Full logs in terminal
✅ **Hot reload** - Changes apply instantly
✅ **No Firebase limits** - No function invocation costs

## Production Deployment

When ready for production:

1. Set `USE_PROXY=true` in production `.env`
2. Configure Bright Data credentials
3. Deploy to Cloud Run
4. Update Firebase Functions to use Cloud Run URL
5. Disable emulator mode in Flutter app

## Security Note

⚠️ **Local mode is for development only!**

- Uses weak API key (`wws_local_dev_key_123`)
- No proxy protection
- Sessions stored locally
- CORS allows all localhost origins

Never use these settings in production!
