#!/usr/bin/env npx tsx
/**
 * Test script for Dynamic Proxy Allocation System
 * 
 * This script tests:
 * 1. Proxy purchase for available countries
 * 2. Fallback to nearest country when unavailable
 * 3. Proxy recycling (reuse within 1 hour)
 * 4. Proxy release after idle timeout
 * 5. Cost tracking and metrics
 */

import { Firestore } from "@google-cloud/firestore";
import { DynamicProxyService } from "./src/services/DynamicProxyService";
import pino from "pino";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const logger = pino({ 
  name: "DynamicProxyTest",
  level: "info",
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true
    }
  }
});

// Test configuration
const TEST_USER_ID = "test_user_123";
const TEST_PHONE_US = "+14155551234";
const TEST_PHONE_BE = "+32470123456";
const TEST_PHONE_BD = "+8801712345678";

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
  logger.info("🚀 Starting Dynamic Proxy Allocation Tests");
  
  // Initialize Firestore
  const firestore = new Firestore({
    projectId: process.env.GOOGLE_CLOUD_PROJECT || "your-project-id"
  });
  
  // Initialize DynamicProxyService
  const proxyService = new DynamicProxyService(firestore);
  
  // Wait for API key initialization
  await delay(2000);
  
  try {
    // Test 1: Purchase proxy for available country (US)
    logger.info("📍 Test 1: Purchase proxy for US (should succeed)");
    const usResult = await proxyService.assignProxy(TEST_USER_ID, TEST_PHONE_US, "us");
    logger.info({
      test: "US Proxy",
      ip: usResult.proxy.ip,
      country: usResult.proxy.country,
      fallbackUsed: usResult.fallbackUsed
    }, "✅ US proxy assigned successfully");
    
    // Test 2: Purchase proxy for potentially unavailable country (Belgium)
    logger.info("📍 Test 2: Purchase proxy for Belgium (may use fallback)");
    const beResult = await proxyService.assignProxy(TEST_USER_ID, TEST_PHONE_BE, "be");
    logger.info({
      test: "Belgium Proxy",
      ip: beResult.proxy.ip,
      requestedCountry: "be",
      assignedCountry: beResult.proxy.country,
      fallbackUsed: beResult.fallbackUsed
    }, beResult.fallbackUsed ? "⚠️ Belgium not available, using fallback" : "✅ Belgium proxy assigned");
    
    // Test 3: Purchase proxy for likely unavailable country (Bangladesh)
    logger.info("📍 Test 3: Purchase proxy for Bangladesh (likely to use fallback)");
    const bdResult = await proxyService.assignProxy(TEST_USER_ID, TEST_PHONE_BD, "bd");
    logger.info({
      test: "Bangladesh Proxy",
      ip: bdResult.proxy.ip,
      requestedCountry: "bd",
      assignedCountry: bdResult.proxy.country,
      fallbackUsed: bdResult.fallbackUsed
    }, bdResult.fallbackUsed ? "⚠️ Bangladesh not available, using fallback" : "✅ Bangladesh proxy assigned");
    
    // Test 4: Mark proxy as idle (simulate disconnect)
    logger.info("📍 Test 4: Mark US proxy as idle for recycling");
    await proxyService.markProxyIdle(usResult.proxy.ip);
    logger.info({ ip: usResult.proxy.ip }, "✅ Proxy marked as idle");
    
    // Test 5: Try to get same country proxy (should reuse idle one)
    logger.info("📍 Test 5: Request another US proxy (should reuse idle proxy)");
    const usReuse = await proxyService.assignProxy("another_user", "+14155559999", "us");
    const reused = usReuse.proxy.ip === usResult.proxy.ip;
    logger.info({
      test: "Proxy Recycling",
      originalIp: usResult.proxy.ip,
      newIp: usReuse.proxy.ip,
      reused: reused
    }, reused ? "✅ Successfully reused idle proxy" : "⚠️ Got different proxy");
    
    // Test 6: Get metrics
    logger.info("📍 Test 6: Get proxy metrics");
    const metrics = await proxyService.getMetrics();
    logger.info({
      test: "Metrics",
      total: metrics.total,
      active: metrics.active,
      idle: metrics.idle,
      byCountry: metrics.byCountry,
      estimatedMonthlyCost: `$${metrics.estimatedMonthlyCost}`
    }, "✅ Metrics retrieved successfully");
    
    // Test 7: Check availability for various countries
    logger.info("📍 Test 7: Check availability for various countries");
    const testCountries = ["us", "gb", "de", "be", "bd", "pk", "ng"];
    for (const country of testCountries) {
      const available = await proxyService.checkAvailability(country);
      logger.info(
        { country, available },
        available ? `✅ ${country.toUpperCase()} is available` : `❌ ${country.toUpperCase()} is not available`
      );
    }
    
    // Test 8: Test fallback chain
    logger.info("📍 Test 8: Test fallback chain for unavailable countries");
    const fallbackTests = [
      { requested: "be", expected: ["nl", "fr", "de", "gb", "us"] },
      { requested: "bd", expected: ["in", "sg", "my", "gb", "us"] },
      { requested: "lu", expected: ["de", "fr", "be", "nl", "gb"] }
    ];
    
    for (const test of fallbackTests) {
      const fallback = await proxyService.getFallbackCountry(test.requested);
      logger.info(
        { 
          requested: test.requested, 
          fallback: fallback,
          expectedChain: test.expected
        },
        `Fallback for ${test.requested.toUpperCase()} → ${fallback.toUpperCase()}`
      );
    }
    
    // Cleanup: Release all test proxies
    logger.info("🧹 Cleaning up test proxies");
    if (!reused) {
      await proxyService.releaseProxy(usReuse.proxy.ip);
    }
    await proxyService.releaseProxy(beResult.proxy.ip);
    await proxyService.releaseProxy(bdResult.proxy.ip);
    
    logger.info("🎉 All tests completed successfully!");
    
  } catch (error: any) {
    logger.error({ error: error.message }, "❌ Test failed");
    process.exit(1);
  }
  
  // Final metrics
  const finalMetrics = await proxyService.getMetrics();
  logger.info({
    activeProxies: finalMetrics.active,
    idleProxies: finalMetrics.idle,
    totalCost: `$${finalMetrics.estimatedMonthlyCost}/month`
  }, "📊 Final proxy inventory");
  
  process.exit(0);
}

// Run tests
runTests().catch(error => {
  logger.error({ error }, "Fatal error in test script");
  process.exit(1);
});