#!/bin/bash

# WhatsApp Web Service - Local Development Starter
# This script sets up and runs the service for local development

echo "🚀 Starting WhatsApp Web Service in Local Mode..."
echo "================================================"

# Check if .env exists, if not copy from .env.local
if [ ! -f .env ]; then
    echo "📝 Creating .env from .env.local..."
    cp .env.local .env
    echo "✅ Environment file created"
else
    echo "✅ Using existing .env file"
fi

# Create sessions directory if it doesn't exist
if [ ! -d sessions ]; then
    echo "📁 Creating sessions directory..."
    mkdir -p sessions
    chmod 755 sessions
    echo "✅ Sessions directory created"
fi

# Check if node_modules exists
if [ ! -d node_modules ]; then
    echo "📦 Installing dependencies (this may take a few minutes)..."
    npm install --legacy-peer-deps
    echo "✅ Dependencies installed"
else
    echo "✅ Dependencies already installed"
    echo "📦 Updating dependencies..."
    npm install --legacy-peer-deps
fi

echo ""
echo "================================================"
echo "🎉 Starting development server..."
echo "================================================"
echo ""

# Check proxy status from .env
if grep -q "USE_PROXY=true" .env 2>/dev/null; then
    PROXY_TYPE=$(grep "BRIGHT_DATA_PROXY_TYPE=" .env | cut -d'=' -f2)
    PROXY_ZONE=$(grep "BRIGHT_DATA_ZONE=" .env | cut -d'=' -f2)
    echo "📍 Service URL:    http://localhost:8090"
    echo "📍 Health Check:   http://localhost:8090/health"
    echo "🔐 API Key:        wws_local_dev_key_123"
    echo "🌐 Proxy:          ENABLED (${PROXY_TYPE:-residential} - ${PROXY_ZONE:-default})"
else
    echo "📍 Service URL:    http://localhost:8090"
    echo "📍 Health Check:   http://localhost:8090/health"
    echo "🔐 API Key:        wws_local_dev_key_123"
    echo "🚫 Proxy:          DISABLED (direct connection)"
fi
echo ""
echo "💡 To connect from Flutter app:"
echo "   1. Open Dashboard in the app"
echo "   2. Click 'Use Emulator' button"
echo "   3. Navigate to WhatsApp Web setup"
echo ""
echo "Press Ctrl+C to stop the server"
echo "================================================"
echo ""

# Start the development server using npx to ensure tsx is available
npx tsx watch src/server.ts