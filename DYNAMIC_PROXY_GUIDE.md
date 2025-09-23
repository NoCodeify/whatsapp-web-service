# Dynamic Proxy Allocation System

## Overview

The Dynamic Proxy Allocation System enables on-demand proxy purchasing for WhatsApp Web connections, supporting users from any country without pre-purchasing proxies. This system automatically handles fallback to nearby countries when specific locations are unavailable.

## Key Features

- **On-Demand Purchasing**: Buy proxies only when users connect (~$4/proxy/month)
- **Global Coverage**: Support 195 countries without upfront investment
- **Smart Fallback**: Automatic fallback to nearest available country
- **Proxy Recycling**: 1-hour retention for disconnected proxies
- **Cost Optimization**: Pay only for active connections
- **Secure API Management**: Integration with Google Secret Manager

## Architecture

```
User Connects (Belgium)
    ↓
DynamicProxyService.assignProxy("be")
    ↓
Try Purchase Belgium Proxy → Fails (Not Available)
    ↓
getFallbackCountry("be") → Netherlands ("nl")
    ↓
Purchase Netherlands Proxy → Success
    ↓
Assign to User → WhatsApp Connects
    ↓
User Disconnects
    ↓
Mark Proxy Idle (1 hour recycling)
    ↓
After 1 hour → Release Proxy (Stop Billing)
```

## Configuration

### Environment Variables

```env
# Proxy Configuration
USE_PROXY=true
BRIGHT_DATA_PROXY_TYPE=isp
BRIGHT_DATA_CUSTOMER_ID=hl_f3479008
BRIGHT_DATA_ZONE=isp_proxy1
BRIGHT_DATA_ZONE_PASSWORD=your_password
BRIGHT_DATA_HOST=brd.superproxy.io
BRIGHT_DATA_PORT=33335

# API Key (Local Dev Only)
BRIGHT_DATA_API_KEY=your_api_key_here

# Production - Use Secret Manager
BRIGHT_DATA_API_KEY_SECRET=projects/YOUR_PROJECT/secrets/bright-data-api-key/versions/latest
```

### Google Secret Manager Setup

1. Create secret in Google Cloud Console:

```bash
echo -n "your-api-key" | gcloud secrets create bright-data-api-key \
  --data-file=- \
  --replication-policy="automatic"
```

2. Grant service account access:

```bash
gcloud secrets add-iam-policy-binding bright-data-api-key \
  --member="serviceAccount:YOUR_SERVICE_ACCOUNT@PROJECT.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

## Firestore Collections

### proxy_inventory

```typescript
{
  ip: "168.158.163.12",
  port: 33335,
  country: "us",
  status: "active" | "idle" | "releasing",
  assignedTo: "user_123",
  assignedPhone: "+14155551234",
  purchasedAt: Timestamp,
  lastUsed: Timestamp,
  idleSince: Timestamp,
  cost: 4.0
}
```

### proxy_assignments

```typescript
{
  userId: "user_123",
  phoneNumber: "+14155551234",
  proxyIp: "168.158.163.12",
  country: "us",
  requestedCountry: "us",
  fallbackUsed: false,
  assignedAt: Timestamp,
  releasedAt: Timestamp
}
```

## API Integration

### Purchase Proxy

```typescript
POST https://api.brightdata.com/zone/ips
{
  "customer": "hl_f3479008",
  "zone": "isp_proxy1",
  "count": 1,
  "country": "us"
}
```

### Release Proxy

```typescript
DELETE https://api.brightdata.com/zone/ips
{
  "customer": "hl_f3479008",
  "zone": "isp_proxy1",
  "ips": ["168.158.163.12"]
}
```

## Fallback Strategy

### Regional Fallback Chains

```typescript
// Europe
Belgium (be) → Netherlands → France → Germany → UK → US
Luxembourg (lu) → Germany → France → Belgium → Netherlands → UK

// Asia
Bangladesh (bd) → India → Singapore → Malaysia → UK → US
Pakistan (pk) → India → UAE → Singapore → UK → US

// Africa
Nigeria (ng) → South Africa → Kenya → Egypt → UK → US
Ghana (gh) → South Africa → Nigeria → UK → US

// Caribbean
Jamaica (jm) → US → Mexico → Brazil → UK
Barbados (bb) → US → Brazil → UK
```

## Cost Analysis

### Traditional Model (Pre-Purchase)

- 100 proxies × $4/month = $400/month
- Only 30 active users = $280 wasted
- Cannot serve unexpected countries

### Dynamic Model (This System)

- 30 active users × $4/month = $120/month
- 70% cost reduction
- Global coverage without pre-investment

## Testing

### Run Test Suite

```bash
npx tsx test-dynamic-proxy.ts
```

### Test Coverage

1. ✅ Purchase proxy for available country
2. ✅ Fallback to nearest country
3. ✅ Proxy recycling within 1 hour
4. ✅ Automatic release after idle timeout
5. ✅ Cost tracking and metrics
6. ✅ Concurrent user handling

## Monitoring

### Get Metrics

```typescript
const metrics = await dynamicProxyService.getMetrics();
// Returns:
{
  total: 10,
  active: 5,
  idle: 3,
  releasing: 2,
  byCountry: { us: 4, gb: 3, de: 3 },
  estimatedMonthlyCost: 40.00
}
```

### Dashboard Metrics

- Active proxies by country
- Recycling efficiency rate
- Average proxy lifetime
- Cost per user
- Fallback usage rate

## Troubleshooting

### Common Issues

1. **"NO_PROXY_AVAILABLE" Error**
   - Country doesn't have ISP proxies
   - System will automatically use fallback
   - Check logs for assigned country

2. **API Key Issues**
   - Verify Secret Manager permissions
   - Check environment variable fallback
   - Rotate key if exposed

3. **Proxy Not Recycling**
   - Check Firestore permissions
   - Verify 1-hour timer is running
   - Check cleanup job logs

4. **High Costs**
   - Monitor idle proxy count
   - Adjust recycling timeout
   - Check for connection leaks

## Best Practices

1. **Country Selection**
   - Let users select their country in UI
   - Pass country code to backend
   - System handles fallback automatically

2. **Cost Optimization**
   - Monitor recycling efficiency
   - Pre-purchase for top 5 countries only
   - Use metrics to identify patterns

3. **Error Handling**
   - Always implement fallback logic
   - Log all proxy assignments
   - Monitor fallback usage rate

4. **Security**
   - Never hardcode API keys
   - Use Secret Manager in production
   - Rotate keys regularly

## Migration from Static Proxies

1. Enable dynamic purchasing:

   ```env
   BRIGHT_DATA_PROXY_TYPE=isp
   ```

2. Add API key to Secret Manager

3. Deploy updated services

4. Monitor metrics for 24 hours

5. Release unused static proxies

## Support

For issues or questions:

1. Check BrightData dashboard for proxy availability
2. Review Firestore proxy_inventory collection
3. Check application logs for error details
4. Contact BrightData support for API issues
