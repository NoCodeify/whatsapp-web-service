# WhatsApp Web Session Storage Architecture

## Overview

The WhatsApp Web service uses Baileys library which requires storing authentication session data consisting of 54+ JSON files per connected WhatsApp account. These files contain encryption keys, device information, and sync states that are critical for maintaining WhatsApp Web connections.

## Storage Modes

### 1. Local Storage (Development)
- **Mode**: `SESSION_STORAGE_TYPE=local`
- **Use Case**: Development and testing
- **Pros**: 
  - Fastest performance (millisecond access)
  - No cloud dependencies
  - Simple setup
- **Cons**: 
  - Sessions lost on server restart
  - No multi-instance support
  - Manual backup required

### 2. Hybrid Storage (Recommended for Production) ⭐
- **Mode**: `SESSION_STORAGE_TYPE=hybrid`
- **Use Case**: Production deployments
- **Pros**:
  - Best of both worlds: local cache + cloud backup
  - Fast performance with persistence
  - Automatic backup every 5 minutes
  - Sessions survive server restarts
  - Multi-instance support
- **Cons**:
  - Requires Google Cloud Storage
  - Slight additional complexity

### 3. Cloud Storage (High Availability)
- **Mode**: `SESSION_STORAGE_TYPE=cloud`
- **Use Case**: Multi-region deployments
- **Pros**:
  - Full cloud persistence
  - Multi-region support
  - No local disk requirements
- **Cons**:
  - Higher latency
  - More cloud storage operations
  - Higher costs

## Configuration

### Environment Variables

```bash
# Storage mode selection
SESSION_STORAGE_TYPE=hybrid  # Options: local, hybrid, cloud

# Local storage path
SESSION_STORAGE_PATH=./sessions

# Backup interval (milliseconds)
SESSION_BACKUP_INTERVAL=300000  # 5 minutes

# Google Cloud Storage
STORAGE_BUCKET=whatzai-whatsapp-sessions

# Encryption key for cloud storage (required)
SESSION_ENCRYPTION_KEY=your_64_character_hex_key
```

### Generate Encryption Key

```bash
# Generate a secure encryption key
openssl rand -hex 32
```

## Architecture Details

### Session Structure
Each WhatsApp session consists of:
- `creds.json` - Authentication credentials
- `app-state-sync-key-*.json` - Sync keys (40-50 files)
- `app-state-sync-version-*.json` - Version information
- `pre-keys-*.json` - Pre-shared keys

Total: ~54 files per session, ~500KB-1MB total

### Hybrid Mode Operation

1. **Session Creation**:
   - Creates session locally in `SESSION_STORAGE_PATH`
   - Immediately backs up to Google Cloud Storage
   - Sets up automatic backup timer

2. **Session Restoration**:
   - Checks local storage first (fast)
   - If not found, restores from cloud (on server restart)
   - Decrypts and restores all session files

3. **Automatic Backup**:
   - Every 5 minutes (configurable)
   - On connection state changes
   - On graceful shutdown

4. **Encryption**:
   - AES-256-CBC encryption for cloud storage
   - Each file encrypted individually
   - Encryption key never stored in cloud

### Storage Paths

**Local Storage**:
```
./sessions/
  ├── userId1-+1234567890/
  │   ├── creds.json
  │   ├── app-state-sync-key-*.json
  │   └── ...
  └── userId2-+0987654321/
      └── ...
```

**Cloud Storage**:
```
gs://whatzai-whatsapp-sessions/
  └── sessions/
      ├── userId1/
      │   └── +1234567890/
      │       ├── creds.json (encrypted)
      │       ├── app-state-sync-key-*.json (encrypted)
      │       └── ...
      └── userId2/
          └── ...
```

## Setup Instructions

### 1. Create Google Cloud Storage Bucket

```bash
# Create bucket
gsutil mb -p YOUR_PROJECT_ID -c STANDARD -l us-central1 gs://whatzai-whatsapp-sessions

# Set lifecycle policy (optional - delete old sessions after 30 days)
cat > lifecycle.json <<EOF
{
  "lifecycle": {
    "rule": [
      {
        "action": {"type": "Delete"},
        "condition": {"age": 30}
      }
    ]
  }
}
EOF

gsutil lifecycle set lifecycle.json gs://whatzai-whatsapp-sessions
```

### 2. Set IAM Permissions

```bash
# Grant service account storage admin role
gsutil iam ch serviceAccount:YOUR_SERVICE_ACCOUNT@PROJECT.iam.gserviceaccount.com:roles/storage.admin gs://whatzai-whatsapp-sessions
```

### 3. Configure Environment

```bash
# Copy production example
cp .env.production.example .env

# Edit .env and set:
# - SESSION_STORAGE_TYPE=hybrid
# - STORAGE_BUCKET=whatzai-whatsapp-sessions
# - SESSION_ENCRYPTION_KEY=<generated-key>
```

### 4. Deploy

```bash
# Build and deploy
npm run build
gcloud run deploy whatsapp-web-service \
  --source . \
  --set-env-vars="SESSION_STORAGE_TYPE=hybrid"
```

## Monitoring

### Logs to Monitor

```javascript
// Successful backup
"Session backed up to Cloud Storage" 

// Restoration from cloud
"Session restored from Cloud Storage"

// Backup failures (non-critical)
"Failed to backup to Cloud Storage, continuing with local storage"

// Automatic backup scheduled
"Automatic backup scheduled for session"
```

### Metrics

- **Backup Success Rate**: Monitor backup failures
- **Restoration Time**: Track how long cloud restoration takes
- **Storage Usage**: Monitor bucket size and costs
- **Session Count**: Track active sessions

## Troubleshooting

### Session Not Persisting

1. Check environment variables:
   ```bash
   echo $SESSION_STORAGE_TYPE  # Should be "hybrid"
   echo $STORAGE_BUCKET        # Should be set
   ```

2. Verify bucket permissions:
   ```bash
   gsutil ls gs://whatzai-whatsapp-sessions/
   ```

3. Check encryption key:
   ```bash
   # Key should be 64 characters hex
   echo -n $SESSION_ENCRYPTION_KEY | wc -c  # Should output 64
   ```

### Backup Failures

1. Check service account permissions
2. Verify bucket exists and is accessible
3. Check network connectivity to GCS
4. Review logs for specific error messages

### High Latency

1. Consider increasing `SESSION_BACKUP_INTERVAL`
2. Monitor GCS operation metrics
3. Ensure bucket is in same region as service

## Best Practices

1. **Always use encryption** for cloud storage
2. **Set up monitoring** for backup failures
3. **Test restoration** process regularly
4. **Rotate encryption keys** periodically
5. **Set bucket lifecycle** policies for old sessions
6. **Use regional buckets** for better performance
7. **Monitor costs** - each session backup is ~50 write operations

## Migration Guide

### From Local to Hybrid

1. Set up GCS bucket and permissions
2. Update environment variables
3. Restart service - existing sessions will be backed up
4. Test by restarting service and verifying sessions restore

### From Hybrid to Local (Emergency)

1. Set `SESSION_STORAGE_TYPE=local`
2. Restart service
3. Sessions will continue working locally
4. Note: Will lose persistence on next restart

## Security Considerations

1. **Encryption Key Management**:
   - Store in secret manager, not in code
   - Rotate periodically
   - Different keys per environment

2. **Access Control**:
   - Limit bucket access to service account only
   - Enable audit logging
   - Use VPC Service Controls if possible

3. **Data Residency**:
   - Choose bucket location based on compliance needs
   - Consider data sovereignty requirements

## Cost Estimation

**Per Session**:
- Storage: ~1MB × $0.02/GB/month = $0.00002/month
- Operations: ~50 writes × $0.005/10000 = $0.000025
- Total: ~$0.00005/session/month

**For 1000 Sessions**:
- Storage: $0.02/month
- Operations: $0.25/month (with 5-minute backups)
- Total: <$1/month

## FAQ

**Q: Why not store sessions directly in Firestore?**
A: Baileys requires file system access for its `useMultiFileAuthState` function. Each session has 54+ files that would exceed Firestore document limits.

**Q: Can I use AWS S3 instead of Google Cloud Storage?**
A: Yes, but you'll need to modify the `SessionManager` class to use AWS SDK instead of @google-cloud/storage.

**Q: How long do sessions stay valid?**
A: WhatsApp Web sessions typically stay valid for 14-30 days of inactivity. The service will attempt to reconnect automatically.

**Q: What happens if backup fails?**
A: The service continues working with local storage. Backups are retried on the next interval.

**Q: Can I disable automatic backups?**
A: Yes, set `SESSION_BACKUP_INTERVAL=0` to disable automatic backups (not recommended).

## Support

For issues or questions:
1. Check logs for error messages
2. Review this documentation
3. Open an issue on GitHub
4. Contact the development team