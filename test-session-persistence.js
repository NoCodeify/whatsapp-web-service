#!/usr/bin/env node

/**
 * Test script to verify WhatsApp Web session persistence across restarts
 *
 * Usage:
 *   node test-session-persistence.js
 *
 * This script will:
 * 1. Check if sessions exist locally
 * 2. Verify cloud backup if hybrid mode is enabled
 * 3. Simulate a restart by clearing local sessions
 * 4. Attempt to restore from cloud
 * 5. Verify restoration was successful
 */

const fs = require("fs").promises;
const path = require("path");
const { Storage } = require("@google-cloud/storage");
const crypto = require("crypto");

// Load environment variables
require("dotenv").config();

const SESSION_STORAGE_TYPE = process.env.SESSION_STORAGE_TYPE || "local";
const SESSION_STORAGE_PATH = process.env.SESSION_STORAGE_PATH || "./sessions";
const STORAGE_BUCKET =
  process.env.STORAGE_BUCKET || "whatzai-whatsapp-sessions";
const SESSION_ENCRYPTION_KEY =
  process.env.SESSION_ENCRYPTION_KEY || crypto.randomBytes(32).toString("hex");

console.log("🔍 Session Persistence Test");
console.log("===========================");
console.log(`Storage Type: ${SESSION_STORAGE_TYPE}`);
console.log(`Local Path: ${SESSION_STORAGE_PATH}`);
console.log(`Bucket: ${STORAGE_BUCKET}`);
console.log("");

async function listLocalSessions() {
  try {
    const dirs = await fs.readdir(SESSION_STORAGE_PATH);
    const sessions = [];

    for (const dir of dirs) {
      const sessionPath = path.join(SESSION_STORAGE_PATH, dir);
      const stats = await fs.stat(sessionPath);

      if (stats.isDirectory()) {
        const files = await fs.readdir(sessionPath);
        sessions.push({
          name: dir,
          fileCount: files.length,
          path: sessionPath,
          modified: stats.mtime,
        });
      }
    }

    return sessions;
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function listCloudSessions() {
  if (SESSION_STORAGE_TYPE === "local") {
    return [];
  }

  try {
    const storage = new Storage();
    const bucket = storage.bucket(STORAGE_BUCKET);
    const [files] = await bucket.getFiles({ prefix: "sessions/" });

    // Group files by session
    const sessions = {};

    for (const file of files) {
      const parts = file.name.split("/");
      if (parts.length >= 4) {
        const sessionKey = `${parts[1]}-${parts[2]}`;
        if (!sessions[sessionKey]) {
          sessions[sessionKey] = {
            name: sessionKey,
            fileCount: 0,
            files: [],
            size: 0,
          };
        }
        sessions[sessionKey].fileCount++;
        sessions[sessionKey].files.push(file.name);
        sessions[sessionKey].size += parseInt(file.metadata.size || 0);
      }
    }

    return Object.values(sessions);
  } catch (error) {
    console.error("Error listing cloud sessions:", error.message);
    return [];
  }
}

async function backupSession(sessionPath, sessionName) {
  if (SESSION_STORAGE_TYPE === "local") {
    console.log("⚠️  Skipping backup - local mode only");
    return false;
  }

  try {
    const storage = new Storage();
    const bucket = storage.bucket(STORAGE_BUCKET);
    const files = await fs.readdir(sessionPath);

    const [userId, phoneNumber] = sessionName.split("-");

    for (const file of files) {
      const filePath = path.join(sessionPath, file);
      const content = await fs.readFile(filePath);

      // Simple encryption (production should use proper encryption)
      const encrypted = encrypt(content);

      const blob = bucket.file(`sessions/${userId}/${phoneNumber}/${file}`);
      await blob.save(encrypted);
    }

    console.log(`✅ Backed up ${files.length} files to cloud`);
    return true;
  } catch (error) {
    console.error("❌ Backup failed:", error.message);
    return false;
  }
}

async function clearLocalSession(sessionPath) {
  try {
    await fs.rm(sessionPath, { recursive: true, force: true });
    console.log("🗑️  Cleared local session");
    return true;
  } catch (error) {
    console.error("❌ Failed to clear local session:", error.message);
    return false;
  }
}

async function restoreSession(sessionName) {
  if (SESSION_STORAGE_TYPE === "local") {
    console.log("⚠️  Skipping restore - local mode only");
    return false;
  }

  try {
    const storage = new Storage();
    const bucket = storage.bucket(STORAGE_BUCKET);
    const [userId, phoneNumber] = sessionName.split("-");

    const sessionPath = path.join(SESSION_STORAGE_PATH, sessionName);
    await fs.mkdir(sessionPath, { recursive: true });

    const prefix = `sessions/${userId}/${phoneNumber}/`;
    const [files] = await bucket.getFiles({ prefix });

    for (const file of files) {
      const fileName = path.basename(file.name);
      const filePath = path.join(sessionPath, fileName);

      const [content] = await file.download();

      // Decrypt content
      const decrypted = decrypt(content);

      await fs.writeFile(filePath, decrypted);
    }

    console.log(`✅ Restored ${files.length} files from cloud`);
    return true;
  } catch (error) {
    console.error("❌ Restore failed:", error.message);
    return false;
  }
}

// Simple encryption/decryption for testing
function encrypt(data) {
  const iv = crypto.randomBytes(16);
  const key = Buffer.from(SESSION_ENCRYPTION_KEY.slice(0, 64), "hex");
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);

  return Buffer.concat([iv, cipher.update(data), cipher.final()]);
}

function decrypt(data) {
  const iv = data.slice(0, 16);
  const encrypted = data.slice(16);
  const key = Buffer.from(SESSION_ENCRYPTION_KEY.slice(0, 64), "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

async function testPersistence() {
  console.log("📁 Step 1: Check Local Sessions");
  console.log("--------------------------------");
  const localSessions = await listLocalSessions();

  if (localSessions.length === 0) {
    console.log("No local sessions found");
    console.log("\n💡 To test persistence:");
    console.log("1. Connect a WhatsApp account first");
    console.log("2. Run this script again");
    return;
  }

  console.log(`Found ${localSessions.length} local session(s):`);
  for (const session of localSessions) {
    console.log(`  • ${session.name} (${session.fileCount} files)`);
  }

  if (SESSION_STORAGE_TYPE === "hybrid" || SESSION_STORAGE_TYPE === "cloud") {
    console.log("\n☁️  Step 2: Check Cloud Backup");
    console.log("--------------------------------");
    const cloudSessions = await listCloudSessions();
    console.log(`Found ${cloudSessions.length} cloud session(s):`);
    for (const session of cloudSessions) {
      const sizeMB = (session.size / 1024 / 1024).toFixed(2);
      console.log(
        `  • ${session.name} (${session.fileCount} files, ${sizeMB} MB)`,
      );
    }

    // Test with first session
    const testSession = localSessions[0];
    console.log(`\n🧪 Step 3: Test Persistence with "${testSession.name}"`);
    console.log("--------------------------------");

    // Backup if not already in cloud
    const cloudSession = cloudSessions.find((s) => s.name === testSession.name);
    if (!cloudSession) {
      console.log("📤 Backing up session to cloud...");
      await backupSession(testSession.path, testSession.name);
    } else {
      console.log("✅ Session already backed up to cloud");
    }

    // Simulate restart
    console.log("\n🔄 Step 4: Simulate Server Restart");
    console.log("--------------------------------");
    console.log("Clearing local session to simulate restart...");
    await clearLocalSession(testSession.path);

    // Verify it's gone
    const afterClear = await listLocalSessions();
    const stillExists = afterClear.find((s) => s.name === testSession.name);
    if (!stillExists) {
      console.log("✅ Local session cleared successfully");
    } else {
      console.log("❌ Failed to clear local session");
      return;
    }

    // Restore from cloud
    console.log("\n📥 Step 5: Restore from Cloud");
    console.log("--------------------------------");
    console.log("Attempting to restore session from cloud...");
    const restored = await restoreSession(testSession.name);

    if (restored) {
      // Verify restoration
      const afterRestore = await listLocalSessions();
      const restoredSession = afterRestore.find(
        (s) => s.name === testSession.name,
      );

      if (restoredSession) {
        console.log(`✅ Session restored: ${restoredSession.fileCount} files`);
        console.log("\n🎉 SUCCESS: Session persistence is working!");
        console.log(
          "Sessions will survive server restarts in hybrid/cloud mode.",
        );
      } else {
        console.log("❌ Session restoration verification failed");
      }
    }
  } else {
    console.log("\n⚠️  Local Mode Warning");
    console.log("--------------------------------");
    console.log("Sessions are stored locally only.");
    console.log("They will be LOST on server restart!");
    console.log("\nTo enable persistence:");
    console.log("1. Set SESSION_STORAGE_TYPE=hybrid in .env");
    console.log("2. Configure Google Cloud Storage");
    console.log("3. Restart the service");
  }
}

// Run the test
testPersistence().catch((error) => {
  console.error("\n❌ Test failed:", error);
  process.exit(1);
});
