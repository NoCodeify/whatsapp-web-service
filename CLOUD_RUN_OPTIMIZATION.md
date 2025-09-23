# Cloud Run Optimization for WhatsApp Web Service

## Overview

This document explains the Cloud Run configuration optimizations specifically designed for the WhatsApp Web Service, which maintains persistent WebSocket connections and requires special handling for memory and CPU resources.

## Configuration Comparison

### Development Environment (`cloudbuild-dev.yaml`)

```yaml
Memory: 4Gi
CPU: 2 cores
Min Instances: 1
Max Instances: 5
Concurrency: 10
No CPU Throttling: Enabled
CPU Boost: Enabled
```

### Production Environment (`cloudbuild-prod.yaml`)

```yaml
Memory: 8Gi
CPU: 4 cores
Min Instances: 2
Max Instances: 10
Concurrency: 5
No CPU Throttling: Enabled
CPU Boost: Enabled
```

## Key Optimizations

### 1. Memory Configuration

- **Development**: 4Gi (increased from 2Gi)
- **Production**: 8Gi

**Rationale**: WhatsApp Web connections require significant memory for:
- Session storage and authentication state
- Message queues and chat history
- WebSocket connection buffers
- Baileys library internal state

### 2. CPU Configuration

- **Development**: 2 cores (increased from 1)
- **Production**: 4 cores
- **CPU Throttling**: Disabled for both environments
- **CPU Boost**: Enabled for both environments

**Rationale**:
- WebSocket keep-alive and message processing require consistent CPU
- Disabled throttling prevents connection drops due to CPU limitations
- CPU boost improves response times for connection establishment

### 3. Instance Configuration

- **Development**: Min 1, Max 5 (changed from Min 0, Max 3)
- **Production**: Min 2, Max 10

**Rationale**:
- Minimum instances prevent cold starts which can disrupt WebSocket connections
- Higher maximum allows for better load distribution
- Prevents connection timeouts during scaling events

### 4. Concurrency Settings

- **Development**: 10 (reduced from 100)
- **Production**: 5

**Rationale**:
- Lower concurrency ensures each instance has sufficient resources per connection
- WhatsApp Web connections are stateful and resource-intensive
- Prevents memory exhaustion under high load

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
- **Estimated Cost**: ~$50-100/month
- **Justification**: Sufficient for testing and development workloads

### Production Environment
- **Estimated Cost**: ~$200-500/month (depending on load)
- **Justification**: Cost-effective compared to managing dedicated infrastructure
- **Scaling**: Costs scale with actual usage due to per-instance billing

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