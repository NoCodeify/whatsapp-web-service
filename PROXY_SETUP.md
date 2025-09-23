# ISP Proxy Configuration Guide

This guide explains how to configure and use Bright Data ISP proxies with the WhatsApp Web Service.

## Overview

The WhatsApp Web Service supports Bright Data ISP proxies to provide dedicated residential IP addresses for each WhatsApp connection. This ensures:

- **Stable connections**: Each phone number gets a dedicated IP that doesn't change
- **Better reliability**: ISP proxies are from real internet service providers
- **Reduced detection**: Looks like genuine home/business internet connections
- **Session persistence**: Same IP maintained across reconnections

## Configuration

### Environment Variables

Add the following to your `.env` file:

```env
# Enable proxy support
USE_PROXY=true
BRIGHT_DATA_PROXY_TYPE=isp

# Bright Data ISP Proxy Configuration
BRIGHT_DATA_API_KEY=your_api_key_here
BRIGHT_DATA_CUSTOMER_ID=your_customer_id
BRIGHT_DATA_ZONE=your_isp_zone_name
BRIGHT_DATA_ZONE_PASSWORD=your_zone_password
BRIGHT_DATA_HOST=brd.superproxy.io
BRIGHT_DATA_PORT=33335  # ISP proxy port
```

### Getting Your Credentials

1. **Log in to Bright Data Dashboard**: https://brightdata.com
2. **Navigate to Zones**: Find your ISP proxy zone
3. **Get Access Details**:
   - Customer ID: Format like `hl_f3479008`
   - Zone Name: Your ISP zone name (e.g., `isp_proxy1`)
   - Zone Password: Your zone-specific password
4. **Get API Key**: Go to Account Settings → API → Generate API Token

## How It Works

### IP Assignment Flow

1. **First Connection**: When a phone number connects for the first time, it gets assigned a unique session ID
2. **Sticky Session**: The session ID ensures the same IP is used for all connections
3. **Persistence**: IP assignments are stored in Firestore for consistency
4. **Automatic Management**: The system handles IP allocation automatically

### Session-Based Architecture

```
Phone Number: +31612345678
     ↓
Generate Session ID: isp_session_abc123
     ↓
Bright Data Username: brd-customer-{id}-zone-{zone}-session-{sessionId}
     ↓
Assigned IP: 95.214.247.75 (Amsterdam, NL)
     ↓
All connections use this IP
```

## Testing

### 1. Test ISP Proxy Connection

Run the test script to verify your proxy configuration:

```bash
npx tsx test-isp-proxy.ts
```

Expected output:

```
✅ Response: Welcome to Bright Data!
✅ IP Info: { "ip": "95.214.247.75", "country": "NL" }
✅ Sticky session working - Same IP
🎉 All ISP proxy tests passed!
```

### 2. Test via API

Start the server and test the proxy endpoints:

```bash
# Start server
npm run dev

# Test proxy status
curl -X GET http://localhost:8090/api/proxy/status \
  -H "x-api-key: wws_local_dev_key_123" \
  -H "x-user-id: test_user"

# Test proxy connection
curl -X POST http://localhost:8090/api/proxy/test \
  -H "x-api-key: wws_local_dev_key_123" \
  -H "x-user-id: test_user" \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber": "+31612345678"}'
```

## API Endpoints

### Proxy Management

- `GET /api/proxy/status` - Get proxy configuration and metrics
- `POST /api/proxy/test` - Test proxy connection
- `GET /api/proxy/locations` - List available proxy locations
- `POST /api/proxy/rotate` - Force proxy rotation for a phone number

## Monitoring

### Metrics Available

The proxy system tracks:

- Active sessions count
- IP assignments per phone number
- Session age and rotation count
- ISP proxy utilization

Access metrics via:

```javascript
GET /api/proxy/status

Response:
{
  "enabled": true,
  "type": "isp",
  "metrics": {
    "activeSessions": 5,
    "ispProxy": {
      "total": 10,
      "assigned": 5,
      "available": 5,
      "utilizationRate": 50
    }
  }
}
```

## Troubleshooting

### Common Issues

1. **Connection Failed**
   - Verify your IP is whitelisted in Bright Data dashboard
   - Check zone name and password are correct
   - Ensure ISP proxy zone is active

2. **No Available IPs**
   - Check if you have purchased ISP proxy IPs
   - Verify zone has available capacity
   - Check Bright Data dashboard for alerts

3. **Session Not Sticky**
   - Ensure session ID is being generated correctly
   - Check if proxy configuration includes session parameter
   - Verify Firestore is storing assignments

### Debug Mode

Enable debug logging:

```env
LOG_LEVEL=debug
```

Check logs for proxy-related messages:

```bash
npm run dev | grep -i proxy
```

## Security Best Practices

1. **Protect Credentials**:
   - Never commit `.env` file to version control
   - Regenerate API keys periodically
   - Use environment variables only

2. **IP Whitelisting**:
   - Only whitelist necessary IPs in Bright Data
   - Use IP ranges instead of 0.0.0.0/0
   - Monitor unauthorized access attempts

3. **Session Management**:
   - Clean up old sessions regularly
   - Monitor for unusual patterns
   - Implement rate limiting

## Production Deployment

For production:

1. **Use Secret Manager**:

   ```javascript
   // Use Google Secret Manager or similar
   const apiKey = await secretManager.getSecret("BRIGHT_DATA_API_KEY");
   ```

2. **Scale Considerations**:
   - Purchase enough ISP IPs for your expected load
   - Monitor utilization rates
   - Implement automatic scaling triggers

3. **Monitoring**:
   - Set up alerts for proxy failures
   - Track IP utilization metrics
   - Monitor connection success rates

## Cost Optimization

1. **ISP Proxy Pricing**:
   - Charged per IP per month
   - No bandwidth charges for ISP proxies
   - More cost-effective for high-volume usage

2. **Optimization Tips**:
   - Release unused IPs promptly
   - Implement connection pooling
   - Use session persistence to minimize reconnections

## Support

For issues or questions:

1. Check Bright Data documentation: https://docs.brightdata.com
2. Contact Bright Data support for proxy-specific issues
3. Review application logs for connection details

## Additional Resources

- [Bright Data ISP Proxies Documentation](https://docs.brightdata.com/proxy-types/isp-proxies)
- [Session Management Best Practices](https://docs.brightdata.com/api-reference/proxy-sessions)
- [Troubleshooting Guide](https://docs.brightdata.com/troubleshooting)
