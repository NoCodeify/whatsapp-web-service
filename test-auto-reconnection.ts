#!/usr/bin/env npx tsx
/**
 * Test script for Auto-Reconnection System
 * 
 * This script tests:
 * 1. Server restart scenario simulation
 * 2. Proxy assignment recovery
 * 3. WhatsApp session reconnection
 * 4. Graceful vs ungraceful shutdown handling
 * 5. Multiple instance coordination
 */

import { Firestore, Timestamp } from "@google-cloud/firestore";
import { DynamicProxyService } from "./src/services/DynamicProxyService";
import { SessionRecoveryService } from "./src/services/SessionRecoveryService";
import pino from "pino";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const logger = pino({ 
  name: "AutoReconnectionTest",
  level: "info",
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true
    }
  }
});

// Test data
const TEST_SCENARIOS = [
  {
    name: "Graceful Restart",
    description: "Simulate a graceful server restart",
    userId: "test_user_graceful",
    phoneNumber: "+14155551111",
    country: "us",
    graceful: true
  },
  {
    name: "Crash Recovery", 
    description: "Simulate recovery after server crash",
    userId: "test_user_crash",
    phoneNumber: "+32470111222",
    country: "be",
    graceful: false
  },
  {
    name: "Multi-Instance",
    description: "Test multiple instances starting simultaneously",
    userId: "test_user_multi",
    phoneNumber: "+447700111333",
    country: "gb",
    graceful: false
  }
];

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runAutoReconnectionTests() {
  logger.info("🚀 Starting Auto-Reconnection System Tests");
  
  // Initialize services
  const firestore = new Firestore({
    projectId: process.env.GOOGLE_CLOUD_PROJECT || "your-project-id"
  });
  
  const dynamicProxyService = new DynamicProxyService(firestore);
  await delay(2000); // Wait for API key initialization
  
  const sessionRecoveryService = new SessionRecoveryService(
    firestore,
    dynamicProxyService,
    "test_instance_main"
  );

  try {
    // Clean up any existing test data
    await cleanupTestData(firestore);
    
    // Test 1: Create active sessions (simulate running server)
    logger.info("📍 Test 1: Creating active sessions");
    const activeSessions = await createActiveTestSessions(dynamicProxyService, firestore);
    
    // Test 2: Simulate graceful shutdown
    logger.info("📍 Test 2: Simulating graceful shutdown");
    await sessionRecoveryService.shutdown();
    
    // Test 3: Simulate server restart and recovery
    logger.info("📍 Test 3: Simulating server restart");
    await delay(1000); // Brief "downtime"
    
    const newRecoveryService = new SessionRecoveryService(
      firestore,
      dynamicProxyService,
      "test_instance_restart"
    );
    
    // Test recovery
    await newRecoveryService.cleanupOldInstances();
    await newRecoveryService.recoverActiveSessions();
    
    // Test 4: Verify proxy reactivation
    logger.info("📍 Test 4: Verifying proxy reactivation");
    await verifyProxyReactivation(firestore, activeSessions);
    
    // Test 5: Test crash scenario (no graceful shutdown)
    logger.info("📍 Test 5: Simulating crash scenario");
    await simulateCrashScenario(firestore, dynamicProxyService);
    
    // Test 6: Multi-instance startup
    logger.info("📍 Test 6: Testing multi-instance startup");
    await testMultiInstanceStartup(firestore, dynamicProxyService);
    
    // Test 7: Proxy availability changes
    logger.info("📍 Test 7: Testing proxy availability changes");
    await testProxyAvailabilityChanges(firestore, dynamicProxyService);
    
    logger.info("🎉 All auto-reconnection tests completed!");
    
  } catch (error: any) {
    logger.error({ error: error.message }, "❌ Auto-reconnection test failed");
    process.exit(1);
  } finally {
    await cleanupTestData(firestore);
  }
  
  process.exit(0);
}

/**
 * Create active test sessions
 */
async function createActiveTestSessions(
  proxyService: DynamicProxyService,
  firestore: Firestore
): Promise<Array<{userId: string, phoneNumber: string, proxyIp: string}>> {
  const sessions = [];
  
  for (const scenario of TEST_SCENARIOS) {
    try {
      // Assign proxy
      const result = await proxyService.assignProxy(
        scenario.userId,
        scenario.phoneNumber,
        scenario.country
      );
      
      // Create WhatsApp phone number record
      await firestore.collection("whatsapp_phone_numbers").doc(
        `${scenario.userId}_${scenario.phoneNumber}`
      ).set({
        user_id: scenario.userId,
        phone_number: scenario.phoneNumber,
        status: "connected",
        proxy_country: result.proxy.country,
        last_activity: Timestamp.now(),
        connection_state: {
          state: "open",
          isNewLogin: false
        },
        created_at: Timestamp.now()
      });
      
      sessions.push({
        userId: scenario.userId,
        phoneNumber: scenario.phoneNumber,
        proxyIp: result.proxy.ip
      });
      
      logger.info(
        { 
          userId: scenario.userId, 
          phoneNumber: scenario.phoneNumber,
          proxyIp: result.proxy.ip,
          country: result.proxy.country
        },
        `✅ Created active session: ${scenario.name}`
      );
      
    } catch (error: any) {
      logger.error(
        { error: error.message, scenario: scenario.name },
        "Failed to create test session"
      );
    }
  }
  
  return sessions;
}

/**
 * Verify proxy reactivation
 */
async function verifyProxyReactivation(
  firestore: Firestore,
  sessions: Array<{userId: string, phoneNumber: string, proxyIp: string}>
): Promise<void> {
  let reactivated = 0;
  let newProxies = 0;
  
  for (const session of sessions) {
    try {
      // Check proxy inventory
      const proxyDoc = await firestore
        .collection("proxy_inventory")
        .doc(session.proxyIp)
        .get();
      
      if (proxyDoc.exists && proxyDoc.data()?.status === "active") {
        reactivated++;
        logger.info(
          { ip: session.proxyIp },
          "✅ Proxy successfully reactivated"
        );
      } else {
        // Check if new proxy was assigned
        const assignmentDoc = await firestore
          .collection("proxy_assignments")
          .doc(`${session.userId}_${session.phoneNumber}`)
          .get();
        
        if (assignmentDoc.exists) {
          const newIp = assignmentDoc.data()?.proxyIp;
          if (newIp !== session.proxyIp) {
            newProxies++;
            logger.info(
              { oldIp: session.proxyIp, newIp },
              "✅ New proxy assigned (original unavailable)"
            );
          }
        }
      }
    } catch (error: any) {
      logger.error({ error: error.message }, "Failed to verify proxy reactivation");
    }
  }
  
  logger.info(
    { reactivated, newProxies, total: sessions.length },
    "Proxy reactivation summary"
  );
}

/**
 * Simulate crash scenario
 */
async function simulateCrashScenario(
  firestore: Firestore,
  proxyService: DynamicProxyService
): Promise<void> {
  // Create a session without graceful shutdown
  const crashUserId = "test_crash_user";
  const crashPhone = "+33612345678";
  
  const result = await proxyService.assignProxy(crashUserId, crashPhone, "fr");
  
  // Simulate WhatsApp connection
  await firestore.collection("whatsapp_phone_numbers").doc(
    `${crashUserId}_${crashPhone}`
  ).set({
    user_id: crashUserId,
    phone_number: crashPhone,
    status: "connected",
    last_activity: Timestamp.now(),
    created_at: Timestamp.now()
  });
  
  // Don't call graceful shutdown (simulate crash)
  logger.info("💥 Simulated server crash (no graceful shutdown)");
  
  await delay(1000);
  
  // Create new recovery service
  const crashRecoveryService = new SessionRecoveryService(
    firestore,
    proxyService,
    "test_crash_recovery_instance"
  );
  
  // Should recover the session
  await crashRecoveryService.recoverActiveSessions();
  
  // Verify recovery
  const recoveryDoc = await firestore
    .collection("session_recovery")
    .doc(`${crashUserId}_${crashPhone}`)
    .get();
  
  if (recoveryDoc.exists && recoveryDoc.data()?.status === "active") {
    logger.info("✅ Crash recovery successful");
  } else {
    logger.error("❌ Crash recovery failed");
  }
}

/**
 * Test multi-instance startup
 */
async function testMultiInstanceStartup(
  firestore: Firestore,
  proxyService: DynamicProxyService
): Promise<void> {
  // Create multiple recovery services simultaneously
  const instances = [
    new SessionRecoveryService(firestore, proxyService, "instance_1"),
    new SessionRecoveryService(firestore, proxyService, "instance_2"), 
    new SessionRecoveryService(firestore, proxyService, "instance_3")
  ];
  
  // All try to recover simultaneously
  const recoveryPromises = instances.map(instance => 
    instance.recoverActiveSessions().catch(err => 
      logger.warn({ error: err.message }, "Instance recovery failed")
    )
  );
  
  await Promise.all(recoveryPromises);
  
  // Check server instances
  const instancesSnapshot = await firestore
    .collection("server_instances")
    .get();
  
  const runningInstances = instancesSnapshot.docs.filter(
    doc => doc.data().status === "running"
  );
  
  logger.info(
    { count: runningInstances.length },
    "Multi-instance startup completed"
  );
}

/**
 * Test proxy availability changes
 */
async function testProxyAvailabilityChanges(
  firestore: Firestore,
  proxyService: DynamicProxyService
): Promise<void> {
  // Test fallback scenario
  const testUserId = "test_fallback_user";
  const testPhone = "+880171234567"; // Bangladesh (likely unavailable)
  
  try {
    const result = await proxyService.assignProxy(testUserId, testPhone, "bd");
    
    if (result.fallbackUsed) {
      logger.info(
        { 
          requested: "bd", 
          assigned: result.proxy.country,
          fallback: result.fallbackUsed 
        },
        "✅ Fallback handling works correctly"
      );
    } else {
      logger.info("Bangladesh proxies are available (unexpected)");
    }
  } catch (error: any) {
    logger.error({ error: error.message }, "Fallback test failed");
  }
}

/**
 * Cleanup test data
 */
async function cleanupTestData(firestore: Firestore): Promise<void> {
  logger.info("🧹 Cleaning up test data");
  
  const collections = [
    "proxy_assignments",
    "proxy_inventory", 
    "whatsapp_phone_numbers",
    "session_recovery",
    "server_instances"
  ];
  
  for (const collectionName of collections) {
    try {
      const snapshot = await firestore
        .collection(collectionName)
        .where("userId", ">=", "test_")
        .get();
      
      const batch = firestore.batch();
      snapshot.forEach(doc => {
        batch.delete(doc.ref);
      });
      
      if (!snapshot.empty) {
        await batch.commit();
        logger.info(`Cleaned ${snapshot.size} documents from ${collectionName}`);
      }
    } catch (error: any) {
      // Also try alternative cleanup queries
      try {
        const testDocs = await firestore
          .collection(collectionName)
          .get();
        
        const batch = firestore.batch();
        testDocs.forEach(doc => {
          const data = doc.data();
          if (data.userId?.startsWith("test_") || data.instanceId?.startsWith("test_")) {
            batch.delete(doc.ref);
          }
        });
        
        await batch.commit();
      } catch (cleanupError) {
        logger.warn(
          { error: cleanupError, collection: collectionName },
          "Failed to cleanup collection"
        );
      }
    }
  }
}

// Run tests
runAutoReconnectionTests().catch(error => {
  logger.error({ error }, "Fatal error in auto-reconnection test");
  process.exit(1);
});