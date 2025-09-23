#!/usr/bin/env tsx

/**
 * Test script for Bright Data ISP Proxy connection
 * Run with: npx tsx test-isp-proxy.ts
 */

import * as dotenv from "dotenv";
import axios from "axios";
import { ProxyAgent } from "proxy-agent";

// Load environment variables
dotenv.config();

const CONFIG = {
  host: process.env.BRIGHT_DATA_HOST || "brd.superproxy.io",
  port: parseInt(process.env.BRIGHT_DATA_PORT || "33335"),
  customerID: process.env.BRIGHT_DATA_CUSTOMER_ID || "",
  zone: process.env.BRIGHT_DATA_ZONE || "",
  password: process.env.BRIGHT_DATA_ZONE_PASSWORD || "",
};

console.log("🔧 ISP Proxy Configuration Test");
console.log("================================");
console.log(`Host: ${CONFIG.host}`);
console.log(`Port: ${CONFIG.port}`);
console.log(`Customer ID: ${CONFIG.customerID}`);
console.log(`Zone: ${CONFIG.zone}`);
console.log(`Password: ${CONFIG.password ? "✓ Set" : "✗ Missing"}`);
console.log("");

async function testDirectConnection() {
  console.log("📡 Testing direct ISP proxy connection...");

  try {
    // Create proxy URL with basic authentication (no session)
    const username = `brd-customer-${CONFIG.customerID}-zone-${CONFIG.zone}`;
    const proxyUrl = `http://${username}:${CONFIG.password}@${CONFIG.host}:${CONFIG.port}`;

    console.log(`Username: ${username}`);

    // Test 1: Check proxy welcome endpoint
    console.log("\n🧪 Test 1: Bright Data welcome endpoint");
    const response1 = await axios.get("https://geo.brdtest.com/welcome.txt", {
      proxy: {
        host: CONFIG.host,
        port: CONFIG.port,
        auth: {
          username: username,
          password: CONFIG.password,
        },
        protocol: "http",
      },
      timeout: 15000,
    });

    console.log("✅ Response:", response1.data);

    // Test 2: Check IP information
    console.log("\n🧪 Test 2: IP information check");
    const response2 = await axios.get("https://lumtest.com/myip.json", {
      proxy: {
        host: CONFIG.host,
        port: CONFIG.port,
        auth: {
          username: username,
          password: CONFIG.password,
        },
        protocol: "http",
      },
      timeout: 15000,
    });

    console.log("✅ IP Info:", JSON.stringify(response2.data, null, 2));

    // Test 3: Session-based connection (sticky IP)
    console.log("\n🧪 Test 3: Session-based connection (sticky IP)");
    const sessionId = `test_session_${Date.now()}`;
    const sessionUsername = `${username}-session-${sessionId}`;

    const response3 = await axios.get("https://lumtest.com/myip.json", {
      proxy: {
        host: CONFIG.host,
        port: CONFIG.port,
        auth: {
          username: sessionUsername,
          password: CONFIG.password,
        },
        protocol: "http",
      },
      timeout: 15000,
    });

    console.log("✅ Session IP:", response3.data.ip);
    console.log("   Country:", response3.data.country);
    console.log("   City:", response3.data.city || "N/A");
    console.log("   ISP:", response3.data.asn?.org || "N/A");

    // Test 4: Verify sticky session (same IP)
    console.log("\n🧪 Test 4: Verify sticky session");
    const response4 = await axios.get("https://lumtest.com/myip.json", {
      proxy: {
        host: CONFIG.host,
        port: CONFIG.port,
        auth: {
          username: sessionUsername,
          password: CONFIG.password,
        },
        protocol: "http",
      },
      timeout: 15000,
    });

    if (response3.data.ip === response4.data.ip) {
      console.log("✅ Sticky session working - Same IP:", response4.data.ip);
    } else {
      console.log(
        "⚠️  IPs differ:",
        response3.data.ip,
        "vs",
        response4.data.ip,
      );
    }

    console.log("\n🎉 All ISP proxy tests passed!");
  } catch (error: any) {
    console.error("\n❌ Proxy test failed:");
    if (error.response) {
      console.error("   Status:", error.response.status);
      console.error("   Data:", error.response.data);
    } else if (error.code) {
      console.error("   Error code:", error.code);
      console.error("   Message:", error.message);
    } else {
      console.error("   Error:", error.message);
    }

    console.log("\n🔍 Troubleshooting tips:");
    console.log("1. Check if your IP is whitelisted in Bright Data dashboard");
    console.log("2. Verify zone name and password are correct");
    console.log("3. Ensure ISP proxy zone is active and has available IPs");
    console.log("4. Check Bright Data dashboard for any errors or alerts");
  }
}

async function testProxyAgent() {
  console.log("\n📡 Testing with ProxyAgent (as used in app)...");

  try {
    const sessionId = `app_test_${Date.now()}`;
    const username = `brd-customer-${CONFIG.customerID}-zone-${CONFIG.zone}-session-${sessionId}`;
    const proxyUrl = `http://${username}:${CONFIG.password}@${CONFIG.host}:${CONFIG.port}`;

    const agent = new ProxyAgent(proxyUrl);

    const response = await axios.get("https://lumtest.com/myip.json", {
      httpsAgent: agent as any,
      httpAgent: agent as any,
      timeout: 15000,
    });

    console.log("✅ ProxyAgent test successful!");
    console.log("   IP:", response.data.ip);
    console.log(
      "   Location:",
      `${response.data.city || "Unknown"}, ${response.data.country}`,
    );
  } catch (error: any) {
    console.error("❌ ProxyAgent test failed:", error.message);
  }
}

// Run tests
(async () => {
  if (!CONFIG.customerID || !CONFIG.password) {
    console.error("❌ Missing required configuration!");
    console.error(
      "   Please ensure BRIGHT_DATA_CUSTOMER_ID and BRIGHT_DATA_ZONE_PASSWORD are set in .env",
    );
    process.exit(1);
  }

  await testDirectConnection();
  await testProxyAgent();

  console.log("\n✨ Testing complete!");
})();
