# Cloud Run Optimization for WhatsApp Web Service

## Overview

This document explains the Cloud Run configuration optimizations specifically designed for the WhatsApp Web Service, which maintains persistent WebSocket connections and requires special handling for memory and CPU resources.

## Configuration Comparison

### Development Environment (`cloudbuild-dev.yaml`)

```yaml
Memory: 2Gi
CPU: 1 core
Min Instances: 1
Max Instances: 1
Concurrency: 25
No CPU Throttling: Enabled
CPU Boost: Enabled
```

### Production Environment (`cloudbuild-prod.yaml`)

```yaml
Memory: 2Gi
CPU: 1 core
Min Instances: 1
Max Instances: 1
Concurrency: 25
No CPU Throttling: Enabled
CPU Boost: Enabled
```

## Key Optimizations

### 1. Memory Configuration

- **Development**: 2Gi (optimized for Baileys)
- **Production**: 2Gi (optimized for Baileys)

**Rationale**: Baileys is a lightweight WhatsApp library that doesn't require browser automation:

- No Chromium/Puppeteer overhead (uses native WhatsApp Web protocol)
- Session storage and authentication state (~50-100MB per connection)
- Message queues and chat history (minimal overhead)
- WebSocket connection buffers (low memory footprint)
- 2Gi sufficient for 20-50 concurrent connections

### 2. CPU Configuration

- **Development**: 1 core (optimized for WebSocket workload)
- **Production**: 1 core (optimized for WebSocket workload)
- **CPU Throttling**: Disabled for both environments
- **CPU Boost**: Enabled for both environments

**Rationale**:

- WebSocket connections are I/O-bound, not CPU-intensive
- 1 vCPU sufficient for message processing and keep-alive
- Disabled throttling prevents connection drops during idle periods
- CPU boost improves cold start and reconnection times

### 3. Instance Configuration

- **Development**: Min 1, Max 1 (single instance for cost optimization)
- **Production**: Min 1, Max 1 (single instance for cost optimization)

**Rationale**:

- Minimum 1 instance prevents cold starts which can disrupt WebSocket connections
- Max 1 instance optimizes costs while maintaining stable service
- Suitable for moderate connection loads (up to 25 concurrent per instance)
- Can be increased if load monitoring shows need for scaling

### 4. Concurrency Settings

- **Development**: 25 (optimized for Baileys)
- **Production**: 25 (optimized for Baileys)

**Rationale**:

- Baileys is lightweight, allowing higher concurrency than browser-based solutions
- 25 concurrent connections per instance balances throughput and stability
- Each connection uses minimal resources (~50-100MB)
- Prevents memory exhaustion while maximizing instance utilization

### 5. Environment Variables

#### Memory Management

- `MEMORY_THRESHOLD`: 0.75 (dev) / 0.8 (prod) - Triggers cleanup before hitting limits
- `MEMORY_DEBUG`: true (dev) / false (prod) - Detailed memory logging
- `MAX_CONNECTIONS`: 20 (dev) / 50 (prod) - Per-instance connection limits

#### WebSocket Optimization

- `WS_KEEPALIVE_INTERVAL`: 20000ms (dev) / 15000ms (prod) - Aggressive keep-alive
- `SESSION_STORAGE_TYPE`: cloud - Use Cloud Storage for persistence
- `SESSION_BACKUP_INTERVAL`: 60000ms (dev) / 120000ms (prod) - Backup frequency

#### Health Monitoring

- `HEALTH_CHECK_INTERVAL`: 30000ms (dev) / 60000ms (prod) - System health checks

## Performance Benefits

### 1. Reduced Connection Drops

- No CPU throttling prevents WebSocket timeouts
- Adequate memory prevents OOM kills
- Minimum instances eliminate cold start disruptions

### 2. Better Resource Utilization

- Lower concurrency allows optimal resource allocation per connection
- CPU boost improves connection establishment times
- Proper memory thresholds prevent resource exhaustion

### 3. Improved Scalability

- Higher maximum instances handle traffic spikes
- Instance warmup prevents scaling delays
- Proper resource allocation supports more concurrent connections

### 4. Enhanced Reliability

- Session persistence in Cloud Storage survives restarts
- Memory leak prevention maintains stable performance
- Aggressive monitoring detects issues early

## Monitoring and Alerting

The optimized configuration includes enhanced monitoring capabilities:

1. **Memory Usage Tracking**: Real-time memory usage vs container limits
2. **WebSocket Health**: Connection state and failure rates
3. **Session Persistence**: Cloud Storage backup success rates
4. **Performance Metrics**: Response times and throughput

## Cost Considerations

### Development Environment

- **Estimated Cost**: ~$37/month (2Gi/1vCPU, always-on)
- **Justification**: Cost-optimized for testing and development workloads
- **Savings**: 75% reduction from previous 4Gi/2vCPU configuration

### Production Environment

- **Estimated Cost**: ~$37/month (2Gi/1vCPU, always-on)
- **Justification**: Cost-effective for moderate load; can scale if needed
- **Scaling**: Fixed cost with current single-instance setup
- **Total Monthly Cost**: ~$74/month (both environments)

### Cost Breakdown

**Per Instance (2Gi RAM, 1 vCPU):**

- CPU: 1 vCPU × $0.000024/sec × 2,592,000 sec/month = $62.21
- Memory: 2 GiB × $0.0000025/sec × 2,592,000 sec/month = $12.96
- **Total per environment**: ~$75/month

**Compared to previous configuration (4Gi/2vCPU):**

- Previous cost: ~$150/month per environment
- New cost: ~$75/month per environment
- **Savings: 50% reduction ($150/month total)**

## Deployment Commands

### Development

```bash
gcloud builds submit --config cloudbuild-dev.yaml .
```

### Production

```bash
gcloud builds submit --config cloudbuild-prod.yaml .
```

## Troubleshooting

### High Memory Usage

1. Check `MEMORY_DEBUG=true` logs for leak sources
2. Verify `MEMORY_THRESHOLD` is appropriate
3. Monitor cache sizes in metrics endpoint

### Connection Drops

1. Verify `WS_KEEPALIVE_INTERVAL` is properly set
2. Check CPU utilization - may need more cores
3. Ensure no CPU throttling is enabled

### Session Loss

1. Verify `SESSION_STORAGE_TYPE=cloud` is set
2. Check Cloud Storage bucket permissions
3. Monitor session backup logs

### Scaling Issues

1. Adjust `MAX_CONNECTIONS` per instance
2. Increase `max-instances` if needed
3. Monitor instance startup times

## Future Optimizations

1. **Regional Deployment**: Deploy to multiple regions for global coverage
2. **Load Balancing**: Implement sticky sessions for WebSocket connections
3. **Auto-scaling**: Custom metrics-based scaling
4. **Cost Optimization**: Preemptible instances for non-critical workloads
