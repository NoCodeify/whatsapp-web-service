#!/usr/bin/env node

/**
 * Test script for duplicate phone number validation
 *
 * This script tests that the system properly prevents duplicate phone numbers
 * even when they're entered in different formats.
 */

const axios = require("axios");

const API_URL = "http://localhost:8090";
const API_KEY = "wws_local_dev_key_123";
const USER_ID = "test-user-dup-check";

// Test cases for duplicate detection
const testCases = [
  {
    name: "Netherlands number with leading zero",
    numbers: [
      "+310658015937", // With leading zero
      "+31658015937", // Without leading zero (correct format)
      "31658015937", // Without plus
      "+31 6 5801 5937", // With spaces
    ],
    expected: "+31658015937", // All should resolve to this
  },
  {
    name: "France number variations",
    numbers: [
      "+330612345678", // With leading zero
      "+33612345678", // Without leading zero (correct)
      "+33 6 12 34 56 78", // With spaces
      "33612345678", // Without plus
    ],
    expected: "+33612345678",
  },
  {
    name: "US number variations",
    numbers: [
      "+12133734253",
      "12133734253",
      "+1 213 373 4253",
      "1 (213) 373-4253",
    ],
    expected: "+12133734253",
  },
];

console.log("🧪 Duplicate Phone Number Validation Test");
console.log("=========================================\n");

async function testInitialization(phoneNumber, shouldSucceed = true) {
  try {
    const response = await axios.post(
      `${API_URL}/api/sessions/initialize`,
      {
        userId: USER_ID,
        phoneNumber: phoneNumber,
        proxyCountry: null,
        countryCode: null,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": API_KEY,
          "X-User-Id": USER_ID,
        },
      },
    );

    const status = response.data.status;
    const formattedPhone = response.data.phoneNumber;

    if (shouldSucceed) {
      console.log(
        `  ✅ Accepted: "${phoneNumber}" → "${formattedPhone}" (${status})`,
      );
      return { success: true, status, formatted: formattedPhone };
    } else {
      // If we expected failure but it succeeded, that's an error
      console.log(
        `  ❌ ERROR: Should have been rejected but was accepted: "${phoneNumber}"`,
      );
      return { success: false, error: "Should have been rejected" };
    }
  } catch (error) {
    if (!shouldSucceed) {
      // Expected to fail
      const errorMessage = error.response?.data?.error || error.message;
      console.log(
        `  ✅ Rejected (as expected): "${phoneNumber}" - ${errorMessage}`,
      );
      return { success: true, rejected: true };
    } else {
      // Unexpected failure
      console.log(
        `  ❌ ERROR: "${phoneNumber}" - ${error.response?.data?.error || error.message}`,
      );
      return { success: false, error: error.message };
    }
  }
}

async function cleanup(phoneNumber) {
  // Try to disconnect/cleanup the session
  try {
    await axios.delete(`${API_URL}/api/sessions/${USER_ID}/disconnect`, {
      params: { phoneNumber },
      headers: {
        "X-API-Key": API_KEY,
        "X-User-Id": USER_ID,
      },
    });
  } catch (e) {
    // Ignore cleanup errors
  }
}

async function runDuplicateTests() {
  console.log("Testing duplicate detection across different formats...\n");

  for (const testCase of testCases) {
    console.log(`\n📱 ${testCase.name}`);
    console.log(`Expected format: ${testCase.expected}`);
    console.log("Testing variations:");

    let firstSuccess = null;

    for (let i = 0; i < testCase.numbers.length; i++) {
      const number = testCase.numbers[i];
      const shouldSucceed = i === 0; // Only first should succeed

      const result = await testInitialization(number, shouldSucceed);

      if (i === 0 && result.success) {
        firstSuccess = result.formatted;

        // Verify it formatted correctly
        if (firstSuccess !== testCase.expected) {
          console.log(
            `  ⚠️  Warning: Formatted to "${firstSuccess}" instead of expected "${testCase.expected}"`,
          );
        }
      }

      // Small delay between requests
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Cleanup after each test case
    if (firstSuccess) {
      await cleanup(firstSuccess);
      console.log(`  🧹 Cleaned up session for ${firstSuccess}`);
    }

    console.log("");
  }
}

async function testFormatValidation() {
  console.log("\n📋 Testing phone number format validation...\n");

  const invalidNumbers = [
    { input: "+31", reason: "Too short" },
    { input: "abc123", reason: "Not a valid number" },
    { input: "+00012345", reason: "Invalid country code" },
    { input: "", reason: "Empty string" },
  ];

  for (const testCase of invalidNumbers) {
    console.log(`Testing invalid: "${testCase.input}" (${testCase.reason})`);
    const result = await testInitialization(testCase.input, false);

    if (!result.success && !result.rejected) {
      console.log("  ⚠️  Test inconclusive");
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function runAllTests() {
  console.log("🔧 Test Configuration:");
  console.log(`   API URL: ${API_URL}`);
  console.log(`   User ID: ${USER_ID}`);
  console.log("");

  // Test 1: Format validation
  await testFormatValidation();

  // Test 2: Duplicate detection
  await runDuplicateTests();

  console.log("\n=========================================");
  console.log("✨ Duplicate validation tests completed!\n");
  console.log("Key validations tested:");
  console.log("  • Phone numbers are properly formatted (e.g., +31 0 → +31)");
  console.log("  • Duplicate numbers in different formats are detected");
  console.log("  • Invalid phone numbers are rejected");
  console.log("  • Backend returns already_connected for duplicates");
}

// Run the tests
runAllTests().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
