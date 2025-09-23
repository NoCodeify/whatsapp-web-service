#!/usr/bin/env node

/**
 * Integration Test Script for WhatsApp Web Service
 * 
 * This script tests the complete flow:
 * 1. HTTP API initialization
 * 2. WebSocket connection
 * 3. QR code generation and delivery
 * 4. Connection status updates
 */

const axios = require('axios');
const io = require('socket.io-client');

const API_URL = 'http://localhost:8090';
const API_KEY = 'wws_local_dev_key_123';
const USER_ID = 'test-user';
const PHONE_NUMBER = '+1234567890'; // Change this to your test number

let socket = null;

console.log('🚀 WhatsApp Web Integration Test');
console.log('================================\n');

async function testInitialization() {
  console.log('1️⃣  Testing API Initialization...');
  try {
    const response = await axios.post(
      `${API_URL}/api/sessions/initialize`,
      {
        userId: USER_ID,
        phoneNumber: PHONE_NUMBER,
        proxyCountry: null,
        countryCode: 'US'
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': API_KEY,
          'X-User-Id': USER_ID
        }
      }
    );
    
    console.log('✅ API Initialization successful');
    console.log('   Status:', response.data.status);
    console.log('   Phone:', response.data.phoneNumber);
    console.log('   Instance URL:', response.data.instanceUrl);
    return true;
  } catch (error) {
    console.error('❌ API Initialization failed:', error.message);
    if (error.response) {
      console.error('   Response:', error.response.data);
    }
    return false;
  }
}

async function testWebSocketConnection() {
  console.log('\n2️⃣  Testing WebSocket Connection...');
  
  return new Promise((resolve) => {
    socket = io(API_URL, {
      transports: ['websocket'],
      auth: {
        token: API_KEY,
        userId: USER_ID,
        phoneNumber: PHONE_NUMBER
      }
    });
    
    socket.on('connect', () => {
      console.log('✅ WebSocket connected');
      console.log('   Socket ID:', socket.id);
      
      // Subscribe to connection updates
      socket.emit('subscribe:connection', {
        phoneNumber: PHONE_NUMBER
      });
      console.log('   Subscribed to connection updates');
      
      resolve(true);
    });
    
    socket.on('connect_error', (error) => {
      console.error('❌ WebSocket connection failed:', error.message);
      resolve(false);
    });
    
    // Set up event listeners
    socket.on('qr:code', (data) => {
      console.log('\n📱 QR Code Received!');
      console.log('   Phone:', data.phoneNumber);
      console.log('   QR Length:', data.qr ? data.qr.length : 0);
      
      if (data.qr) {
        console.log('\n   ⚠️  Open WhatsApp on your phone');
        console.log('   ⚠️  Go to Settings → Linked Devices');
        console.log('   ⚠️  Tap "Link a Device" and scan the QR code');
        console.log('\n   QR Code (first 50 chars):', data.qr.substring(0, 50) + '...');
      }
    });
    
    socket.on('connection:status', (data) => {
      console.log('\n📊 Connection Status Update:');
      console.log('   Phone:', data.phoneNumber);
      console.log('   Status:', data.status);
      console.log('   Has QR:', data.hasQR);
      
      if (data.status === 'connected' || data.status === 'open') {
        console.log('\n🎉 Successfully connected to WhatsApp!');
        process.exit(0);
      }
    });
    
    socket.on('error', (error) => {
      console.error('⚠️  WebSocket error:', error);
    });
    
    socket.on('disconnect', () => {
      console.log('🔌 WebSocket disconnected');
    });
  });
}

async function checkStatus() {
  console.log('\n3️⃣  Checking Connection Status...');
  try {
    const response = await axios.get(
      `${API_URL}/api/sessions/${USER_ID}/status`,
      {
        params: { phoneNumber: PHONE_NUMBER },
        headers: {
          'X-API-Key': API_KEY,
          'X-User-Id': USER_ID
        }
      }
    );
    
    console.log('✅ Status check successful');
    console.log('   Status:', response.data.status);
    console.log('   Has QR:', response.data.hasQR);
    console.log('   Created:', response.data.createdAt);
    return true;
  } catch (error) {
    console.error('❌ Status check failed:', error.message);
    return false;
  }
}

async function runTests() {
  console.log('🔧 Testing environment:');
  console.log('   API URL:', API_URL);
  console.log('   Phone:', PHONE_NUMBER);
  console.log('   User ID:', USER_ID);
  console.log('');
  
  // Test 1: Initialize session
  const initSuccess = await testInitialization();
  if (!initSuccess) {
    console.error('\n❌ Test failed at initialization stage');
    process.exit(1);
  }
  
  // Small delay to ensure backend is ready
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Test 2: Connect WebSocket
  const wsSuccess = await testWebSocketConnection();
  if (!wsSuccess) {
    console.error('\n❌ Test failed at WebSocket connection stage');
    process.exit(1);
  }
  
  // Small delay to allow WebSocket to stabilize
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Test 3: Check status
  await checkStatus();
  
  console.log('\n⏳ Waiting for QR code and connection events...');
  console.log('   (The test will automatically exit when connected)');
  console.log('   Press Ctrl+C to stop\n');
  
  // Keep the script running to receive events
  process.on('SIGINT', () => {
    console.log('\n\n👋 Shutting down test...');
    if (socket) {
      socket.disconnect();
    }
    process.exit(0);
  });
}

// Run the tests
runTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});