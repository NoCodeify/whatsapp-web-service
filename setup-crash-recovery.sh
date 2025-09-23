#!/bin/bash

# WhatsApp Web Service - Crash Recovery Setup Script
# This script sets up all necessary components for crash recovery and message persistence

set -e

echo "🚀 WhatsApp Web Service - Crash Recovery Setup"
echo "============================================="
echo ""

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

# Check if running as root
if [ "$EUID" -eq 0 ]; then 
   print_error "Please don't run this script as root"
   exit 1
fi

# Step 1: Check Node.js version
echo "Step 1: Checking Node.js version..."
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    print_error "Node.js 18+ is required. Current version: $(node -v)"
    exit 1
fi
print_status "Node.js version OK: $(node -v)"
echo ""

# Step 2: Install Redis (if not installed)
echo "Step 2: Setting up Redis..."
if command -v redis-server &> /dev/null; then
    print_status "Redis is already installed"
    
    # Check if Redis is running
    if pgrep -x "redis-server" > /dev/null; then
        print_status "Redis is running"
    else
        print_warning "Redis is installed but not running"
        echo "Starting Redis..."
        
        # Try to start Redis based on OS
        if [[ "$OSTYPE" == "linux-gnu"* ]]; then
            sudo systemctl start redis-server 2>/dev/null || sudo service redis-server start 2>/dev/null || redis-server --daemonize yes
        elif [[ "$OSTYPE" == "darwin"* ]]; then
            brew services start redis 2>/dev/null || redis-server --daemonize yes
        else
            redis-server --daemonize yes
        fi
        
        sleep 2
        if pgrep -x "redis-server" > /dev/null; then
            print_status "Redis started successfully"
        else
            print_error "Failed to start Redis. Please start it manually"
        fi
    fi
else
    print_warning "Redis not found. Installing Redis..."
    
    # Install Redis based on OS
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        # Linux
        if command -v apt-get &> /dev/null; then
            sudo apt-get update
            sudo apt-get install -y redis-server
        elif command -v yum &> /dev/null; then
            sudo yum install -y redis
        else
            print_error "Unable to install Redis automatically. Please install manually"
            exit 1
        fi
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        if command -v brew &> /dev/null; then
            brew install redis
            brew services start redis
        else
            print_error "Homebrew not found. Please install Redis manually"
            exit 1
        fi
    else
        print_error "Unsupported OS. Please install Redis manually"
        exit 1
    fi
    
    print_status "Redis installed successfully"
fi

# Test Redis connection
echo "Testing Redis connection..."
if redis-cli ping > /dev/null 2>&1; then
    print_status "Redis connection successful"
else
    print_error "Cannot connect to Redis. Please check Redis configuration"
    exit 1
fi
echo ""

# Step 3: Install PM2 globally
echo "Step 3: Installing PM2..."
if command -v pm2 &> /dev/null; then
    print_status "PM2 is already installed"
else
    print_warning "Installing PM2 globally..."
    npm install -g pm2
    print_status "PM2 installed successfully"
fi

# Setup PM2 startup script
echo "Setting up PM2 startup script..."
pm2 startup 2>/dev/null || true
print_status "PM2 startup configured"
echo ""

# Step 4: Install dependencies
echo "Step 4: Installing project dependencies..."
npm install
print_status "Dependencies installed"
echo ""

# Step 5: Create necessary directories
echo "Step 5: Creating necessary directories..."
mkdir -p logs
mkdir -p sessions
mkdir -p .env.backup
print_status "Directories created"
echo ""

# Step 6: Setup environment variables
echo "Step 6: Configuring environment..."
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        cp .env.example .env
        print_warning "Created .env from .env.example - Please update with your values"
    else
        print_warning "Creating default .env file..."
        cat > .env << EOF
# Server Configuration
NODE_ENV=production
PORT=8090
API_KEY=wws_production_key_$(openssl rand -hex 16)
WS_TOKEN=wws_ws_token_$(openssl rand -hex 16)

# Redis Configuration
REDIS_HOST=localhost
REDIS_PORT=6379
# REDIS_PASSWORD=your_redis_password

# Session Storage
SESSION_STORAGE_TYPE=hybrid
SESSION_STORAGE_PATH=./sessions
SESSION_BACKUP_INTERVAL=60000
SESSION_ENCRYPTION_KEY=$(openssl rand -hex 32)

# Google Cloud Storage (for hybrid/cloud storage)
# STORAGE_BUCKET=whatzai-whatsapp-sessions
# GOOGLE_CLOUD_PROJECT=your-project-id

# Health Monitoring
HEALTH_CHECK_INTERVAL=30000
AUTO_RECOVERY=true
MAX_ERRORS_THRESHOLD=10
CPU_THRESHOLD=80
MEMORY_THRESHOLD=85
ALERT_THRESHOLD=5

# Resource Limits
MAX_CONNECTIONS=50
MEMORY_THRESHOLD=0.85

# Proxy Configuration (optional)
USE_PROXY=false
# BRIGHT_DATA_CUSTOMER_ID=
# BRIGHT_DATA_ZONE_PASSWORD=

# Firebase Configuration
# FIREBASE_PROJECT_ID=
# FIREBASE_CLIENT_EMAIL=
# FIREBASE_PRIVATE_KEY=

# Logging
LOG_LEVEL=info

# CORS
CORS_ORIGIN=*
EOF
        print_status "Created default .env file"
        print_warning "⚠️  IMPORTANT: Edit .env file and add your configuration"
    fi
else
    # Backup existing .env
    cp .env .env.backup/backup_$(date +%Y%m%d_%H%M%S).env
    print_status "Backed up existing .env file"
    
    # Add new required variables if missing
    if ! grep -q "REDIS_HOST" .env; then
        echo "" >> .env
        echo "# Redis Configuration" >> .env
        echo "REDIS_HOST=localhost" >> .env
        echo "REDIS_PORT=6379" >> .env
        print_status "Added Redis configuration to .env"
    fi
    
    if ! grep -q "HEALTH_CHECK_INTERVAL" .env; then
        echo "" >> .env
        echo "# Health Monitoring" >> .env
        echo "HEALTH_CHECK_INTERVAL=30000" >> .env
        echo "AUTO_RECOVERY=true" >> .env
        print_status "Added health monitoring configuration to .env"
    fi
fi
echo ""

# Step 7: Build the project
echo "Step 7: Building the project..."
npm run build
if [ $? -eq 0 ]; then
    print_status "Build completed successfully"
else
    print_error "Build failed. Please check for TypeScript errors"
    exit 1
fi
echo ""

# Step 8: Setup systemd service (Linux only)
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    echo "Step 8: Setting up systemd service..."
    
    SERVICE_FILE="/etc/systemd/system/whatsapp-web.service"
    if [ -f "$SERVICE_FILE" ]; then
        print_status "Systemd service already exists"
    else
        print_warning "Creating systemd service..."
        sudo tee $SERVICE_FILE > /dev/null << EOF
[Unit]
Description=WhatsApp Web Service
After=network.target redis.service

[Service]
Type=forking
User=$USER
WorkingDirectory=$(pwd)
Environment="PATH=/usr/bin:/usr/local/bin"
Environment="NODE_ENV=production"
ExecStart=/usr/local/bin/pm2 start ecosystem.config.js --env production
ExecReload=/usr/local/bin/pm2 reload ecosystem.config.js --env production
ExecStop=/usr/local/bin/pm2 stop ecosystem.config.js

Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
        
        sudo systemctl daemon-reload
        sudo systemctl enable whatsapp-web.service
        print_status "Systemd service created and enabled"
    fi
    echo ""
fi

# Step 9: Test the setup
echo "Step 9: Running tests..."
echo "Testing message queue..."
node -e "
const Bull = require('bull');
const queue = new Bull('test-queue');
queue.add('test', { message: 'Test message' })
  .then(() => {
    console.log('✓ Message queue test passed');
    process.exit(0);
  })
  .catch(err => {
    console.error('✗ Message queue test failed:', err.message);
    process.exit(1);
  });
" || print_warning "Message queue test failed - check Redis connection"

echo ""

# Step 10: Start the service
echo "Step 10: Starting the service..."
echo ""
echo "Choose how to start the service:"
echo "1) Start with PM2 (recommended for production)"
echo "2) Start with npm run dev (for development)"
echo "3) Don't start now"
echo ""
read -p "Enter your choice (1-3): " choice

case $choice in
    1)
        pm2 delete whatsapp-web-service 2>/dev/null || true
        pm2 start ecosystem.config.js --env production
        pm2 save
        print_status "Service started with PM2"
        echo ""
        echo "PM2 Commands:"
        echo "  pm2 status          - Check service status"
        echo "  pm2 logs            - View logs"
        echo "  pm2 restart all     - Restart service"
        echo "  pm2 stop all        - Stop service"
        echo "  pm2 monit           - Real-time monitoring"
        ;;
    2)
        npm run dev &
        print_status "Service started in development mode"
        echo "Press Ctrl+C to stop"
        ;;
    3)
        print_status "Setup complete. Start the service when ready"
        ;;
    *)
        print_error "Invalid choice"
        ;;
esac

echo ""
echo "============================================="
echo "✅ Crash Recovery Setup Complete!"
echo "============================================="
echo ""
echo "📋 Next Steps:"
echo "1. Edit .env file with your configuration"
echo "2. Configure Google Cloud Storage for session backup (optional)"
echo "3. Set up monitoring alerts in Firebase"
echo "4. Test the crash recovery:"
echo "   - Start the service"
echo "   - Connect a WhatsApp account"
echo "   - Kill the process: pm2 kill"
echo "   - Restart: pm2 start ecosystem.config.js"
echo "   - Verify connection auto-recovers"
echo ""
echo "📊 Monitoring Endpoints:"
echo "  http://localhost:8090/health - Health status"
echo "  http://localhost:8090/api/metrics - Service metrics"
echo ""
echo "📚 Documentation:"
echo "  - Session persistence: SESSION_STORAGE.md"
echo "  - Local development: README_LOCAL_DEV.md"
echo ""
print_status "Setup completed successfully! 🎉"