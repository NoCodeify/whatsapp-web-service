# 🚀 WhatsApp Web Service

[![Deploy Status](https://img.shields.io/badge/deploy-success-brightgreen)](https://whatsapp-web-service-dev-977039419095.europe-central2.run.app/health)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue)](https://typescriptlang.org)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/Docker-enabled-blue)](https://docker.com)
[![Google Cloud](https://img.shields.io/badge/Google%20Cloud-Run-orange)](https://cloud.google.com/run)

Production-ready WhatsApp Web automation service with dynamic proxy management, auto-scaling, and session recovery capabilities.

## ✨ Features

- **🔄 Auto-Scaling**: Intelligent scaling based on connection count and memory usage
- **🌐 Dynamic Proxy Management**: BrightData ISP proxy integration with country-specific routing
- **🔧 Session Recovery**: Automatic reconnection and session persistence after restarts
- **📊 Health Monitoring**: Comprehensive health checks and metrics
- **🔒 Secure**: Secret Manager integration for credentials
- **⚡ WebSocket Support**: Real-time communication
- **📱 Multi-Device**: Support for multiple WhatsApp Web connections
- **📈 Monitoring**: Structured logging with correlation IDs

## 🏗️ Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Client App    │────│  Cloud Run API   │────│  WhatsApp Web   │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                              │
                    ┌─────────┼─────────┐
                    │         │         │
            ┌───────▼───┐ ┌───▼────┐ ┌──▼──────┐
            │ Firestore │ │ Secrets│ │ Proxies │
            │ Sessions  │ │Manager │ │BrightData│
            └───────────┘ └────────┘ └─────────┘
```

## 🚀 Quick Start

### Prerequisites

- Node.js 20+
- Google Cloud account with enabled APIs:
  - Cloud Run
  - Secret Manager
  - Firestore
  - Cloud Build
  - Artifact Registry

### 1. Clone Repository

```bash
git clone https://github.com/NoCodeify/whatsapp-web-service.git
cd whatsapp-web-service
npm install
```

### 2. Environment Setup

Create your environment file:

```bash
cp .env.example .env
```

Configure your `.env` file with:

```env
# Google Cloud
GOOGLE_CLOUD_PROJECT=your-project-id
STORAGE_BUCKET=your-bucket-name

# Proxy Configuration (BrightData)
BRIGHT_DATA_PROXY_TYPE=isp
BRIGHT_DATA_CUSTOMER_ID=your-customer-id
BRIGHT_DATA_ZONE=isp_proxy1
BRIGHT_DATA_PORT=33335

# Service Configuration
NODE_ENV=development
LOG_LEVEL=debug
PORT=8090
MAX_CONNECTIONS=50
MEMORY_THRESHOLD=0.8
```

### 3. Secret Manager Setup

Create required secrets in Google Cloud Secret Manager:

```bash
# API Key for service authentication
gcloud secrets create WHATSAPP_WEB_API_KEY --data-file=- <<< "your-secure-api-key"

# Service URL (will be updated after deployment)
gcloud secrets create WHATSAPP_WEB_SERVICE_URL --data-file=- <<< "https://your-service-url"

# BrightData credentials
gcloud secrets create BRIGHT_DATA_CUSTOMER_ID --data-file=- <<< "your-customer-id"
gcloud secrets create BRIGHT_DATA_ZONE_PASSWORD --data-file=- <<< "your-zone-password"
gcloud secrets create SESSION_ENCRYPTION_KEY --data-file=- <<< "your-32-char-encryption-key"
```

### 4. Local Development

```bash
# Start development server
npm run dev

# Build TypeScript
npm run build

# Start production server
npm start
```

## ☁️ Cloud Deployment

### Google Cloud Run Deployment

1. **Setup Artifact Registry**:
```bash
gcloud artifacts repositories create whatsapp-repo \
  --repository-format=docker \
  --location=europe-central2
```

2. **Deploy using Cloud Build**:
```bash
gcloud builds submit --config cloudbuild-dev.yaml
```

3. **Verify Deployment**:
```bash
curl https://your-service-url/health
```

### CI/CD with GitHub Actions

The repository includes automated deployment workflows:

- **Development**: Auto-deploy on push to `main` branch
- **Production**: Manual deployment with approval
- **Testing**: Automated tests on all pull requests

## 📡 API Documentation

### Authentication

All API endpoints require authentication:

```bash
curl -H "X-API-Key: your-api-key" \
     -H "X-User-Id: user-123" \
     https://your-service-url/api/endpoint
```

### Core Endpoints

#### Health Check
```http
GET /health
```
Returns service health and metrics.

#### Session Management
```http
POST /api/sessions/{userId}/{phoneNumber}/initialize
GET  /api/sessions/{userId}/{phoneNumber}/status
DELETE /api/sessions/{userId}/{phoneNumber}
```

#### Message Sending
```http
POST /api/messages/send
Content-Type: application/json

{
  "userId": "user-123",
  "phoneNumber": "+1234567890",
  "toNumber": "+0987654321",
  "message": "Hello from WhatsApp Web!",
  "media": {
    "url": "https://example.com/image.jpg",
    "type": "image"
  }
}
```

### WebSocket Events

Connect to WebSocket for real-time updates:

```javascript
const ws = new WebSocket('wss://your-service-url');
ws.on('qr-code', (data) => {
  // Display QR code for scanning
});
ws.on('session-status', (data) => {
  // Handle session status changes
});
```

## 🔧 Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment mode | `development` |
| `PORT` | Server port | `8090` |
| `MAX_CONNECTIONS` | Max concurrent connections | `50` |
| `MEMORY_THRESHOLD` | Memory usage threshold for scaling | `0.8` |
| `LOG_LEVEL` | Logging level | `info` |
| `AUTO_RECONNECT` | Enable auto-reconnection | `true` |
| `MAX_RECONNECT_ATTEMPTS` | Max reconnection attempts | `3` |

### Proxy Configuration

The service supports dynamic proxy assignment:

```typescript
interface ProxyConfig {
  type: 'isp' | 'datacenter';
  country: string;
  fallbackChain: string[];
}
```

Country fallback chains are automatically configured for optimal connection reliability.

## 📊 Monitoring & Observability

### Health Metrics

The `/health` endpoint provides comprehensive service metrics:

```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "uptime": 3600,
  "memory": {
    "used": 134217728,
    "total": 268435456,
    "percentage": 50.0
  },
  "connections": {
    "total": 15,
    "active": 12,
    "pending": 3
  },
  "proxy": {
    "totalAssigned": 15,
    "activeCountries": ["us", "gb", "de"]
  }
}
```

### Logging

Structured logging with correlation IDs for request tracing:

```typescript
logger.info({
  correlationId: "req_1234567890_abc123",
  userId: "user-123",
  phoneNumber: "+1234567890",
  action: "message-sent"
}, "WhatsApp message sent successfully");
```

## 🔒 Security

- **API Key Authentication**: All endpoints require valid API keys
- **CORS Configuration**: Configurable origin restrictions
- **Secret Management**: Sensitive data stored in Google Secret Manager
- **Request Validation**: Input sanitization and validation
- **Rate Limiting**: Connection and request rate limiting

## 🧪 Testing

```bash
# Run all tests
npm test

# Run specific test file
npm test -- --testPathPattern=connection.test.ts

# Run tests with coverage
npm test -- --coverage
```

### Integration Testing

The service includes comprehensive integration tests:

- WhatsApp Web connection testing
- Proxy management validation
- Session recovery verification
- API endpoint testing

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Commit changes: `git commit -m 'Add amazing feature'`
4. Push to branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

### Development Guidelines

- Follow TypeScript best practices
- Add tests for new features
- Update documentation
- Use conventional commit messages
- Ensure all tests pass

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

- **Issues**: [GitHub Issues](https://github.com/NoCodeify/whatsapp-web-service/issues)
- **Documentation**: [Wiki](https://github.com/NoCodeify/whatsapp-web-service/wiki)
- **Discussions**: [GitHub Discussions](https://github.com/NoCodeify/whatsapp-web-service/discussions)

## 📈 Roadmap

- [ ] Multi-region deployment support
- [ ] Advanced message templates
- [ ] Webhook integrations
- [ ] Message scheduling
- [ ] Analytics dashboard
- [ ] Load balancing improvements

---

🎉 **Successfully deployed and ready for production use!**

*Generated with [Claude Code](https://claude.ai/code)*

*Co-Authored-By: Claude <noreply@anthropic.com>*