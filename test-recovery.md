# WhatsApp Web Message Sync Recovery Test

## Test Procedure

### 1. Start the server
```bash
npm run dev
```

### 2. Connect WhatsApp account
- Open the WhatsApp Web UI
- Scan QR code
- Wait for sync to complete

### 3. Send test messages
- Send a few messages to confirm it's working
- Check Firestore to verify messages are being stored

### 4. Kill the server
- Press `Ctrl+C` to stop the server
- Or kill the process: `kill -9 <PID>`

### 5. Send messages while offline
- Using your phone, send messages to the connected WhatsApp account
- These messages will be queued on WhatsApp's servers

### 6. Restart the server
```bash
npm run dev
```

### 7. Monitor recovery in logs
Look for these log messages:
```
"WhatsApp Web service started"
"Initiating connection recovery after server restart"
"Starting automatic connection recovery after server restart"
"Found previous connections to recover"
"Attempting to recover WhatsApp connection"
"Successfully recovered WhatsApp connection"
"Connection recovery complete"
"WhatsApp connection established"
"Processing history sync data"
"Messages sync completed"
```

### 8. Verify message sync
- Check Firestore contacts collection
- Look for the messages sent during downtime
- They should appear within 30-60 seconds of recovery

## Expected Behavior

✅ **Working correctly if:**
- No QR code required after restart
- Connection automatically recovers
- Messages sent during downtime appear in Firestore
- Sync events fire and complete

❌ **Not working if:**
- QR code is requested again
- Messages don't appear in Firestore
- Connection fails to recover
- Errors in logs about missing sessions

## Manual Recovery

If automatic recovery doesn't work, you can trigger it manually:

```bash
curl -X POST http://localhost:8090/api/connections/recover \
  -H "x-api-key: your-api-key" \
  -H "x-user-id: your-user-id"
```

## Check Recovery Status

```bash
curl http://localhost:8090/api/connections/status \
  -H "x-api-key: your-api-key" \
  -H "x-user-id: your-user-id"
```

## Troubleshooting

1. **Session files missing**: Check `./sessions/` directory
2. **Connection state not found**: Check Firestore `whatsapp_connection_states` collection
3. **Recovery not triggered**: Check for the 3-second delay log message
4. **Sync not happening**: Verify `syncFullHistory: true` in SessionManager

## Success Criteria

- [x] Server restarts without requiring new QR scan
- [x] Previous connections automatically reconnect
- [x] Messages sent during downtime sync to Firestore
- [x] No data loss during server restarts