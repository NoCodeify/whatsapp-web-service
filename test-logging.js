/**
 * Test script to verify enhanced logging output
 * Run with: node test-logging.js
 */

const axios = require("axios");

const API_URL = process.env.API_URL || "http://localhost:8090";
const API_KEY = process.env.API_KEY || "test-api-key";
const USER_ID = process.env.USER_ID || "test-user-123";

async function testMessageSendLogging() {
  console.log("🧪 Testing enhanced logging for message send endpoint...\n");

  try {
    // Test successful message send (will fail but we want to see the logs)
    const response = await axios.post(
      `${API_URL}/api/messages/send`,
      {
        phoneNumber: "+31612345678",
        toNumber: "+31698765432",
        message: "Test message for logging verification",
        userId: USER_ID,
      },
      {
        headers: {
          "x-api-key": API_KEY,
          "x-user-id": USER_ID,
          "x-correlation-id": "test-correlation-123",
        },
        validateStatus: () => true, // Don't throw on any status code
      },
    );

    console.log("📍 Response Status:", response.status);
    console.log("📍 Response Headers:", {
      correlationId: response.headers["x-correlation-id"],
    });
    console.log("📍 Response Data:", JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error("❌ Request failed:", error.message);
    if (error.response) {
      console.log("📍 Error Response:", error.response.data);
    }
  }
}

async function testInvalidRequest() {
  console.log("\n🧪 Testing enhanced logging for invalid request...\n");

  try {
    const response = await axios.post(
      `${API_URL}/api/messages/send`,
      {
        // Missing required fields to trigger validation error
        phoneNumber: "+31612345678",
      },
      {
        headers: {
          "x-api-key": API_KEY,
          "x-user-id": USER_ID,
        },
        validateStatus: () => true,
      },
    );

    console.log("📍 Response Status:", response.status);
    console.log("📍 Response Data:", JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error("❌ Request failed:", error.message);
  }
}

async function test404Logging() {
  console.log("\n🧪 Testing enhanced 404 logging...\n");

  try {
    const response = await axios.get(`${API_URL}/api/nonexistent/endpoint`, {
      headers: {
        "x-api-key": API_KEY,
        "x-user-id": USER_ID,
      },
      validateStatus: () => true,
    });

    console.log("📍 Response Status:", response.status);
    console.log("📍 Correlation ID:", response.headers["x-correlation-id"]);
    console.log("📍 Response Data:", JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error("❌ Request failed:", error.message);
  }
}

async function runTests() {
  console.log("========================================");
  console.log("   WhatsApp Web Service Logging Test   ");
  console.log("========================================\n");
  console.log(
    "📝 Check your service logs to verify the enhanced logging output",
  );
  console.log(
    "📝 Look for correlation IDs, performance metrics, and structured data\n",
  );

  await testMessageSendLogging();
  await testInvalidRequest();
  await test404Logging();

  console.log("\n========================================");
  console.log("✅ Logging tests completed!");
  console.log("========================================");
  console.log("\n📋 What to check in your logs:");
  console.log("  1. Correlation IDs linking all log entries for a request");
  console.log("  2. Performance metrics (duration, durationMs)");
  console.log("  3. Masked sensitive data (phone numbers)");
  console.log("  4. Detailed error information with stack traces");
  console.log("  5. Request/response metadata");
  console.log("\n📊 In Google Cloud Logging, you can now query by:");
  console.log("  - correlationId");
  console.log("  - userId");
  console.log("  - messageId");
  console.log("  - severity levels");
  console.log("  - performance metrics");
}

// Run the tests
runTests().catch(console.error);
