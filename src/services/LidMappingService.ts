import { Firestore } from "@google-cloud/firestore";
import * as admin from "firebase-admin";
import pino from "pino";

/**
 * LID Mapping Service
 *
 * Manages bidirectional mappings between WhatsApp LID (Linked Device ID) and phone numbers.
 * WhatsApp's privacy system randomly uses either LID or phone number for the same sender,
 * causing message loss and duplicate contacts. This service:
 *
 * 1. Maintains an in-memory cache for fast lookups
 * 2. Persists mappings to Firestore for cross-restart survival
 * 3. Learns mappings automatically from duplicate messages
 *
 * @see https://github.com/WhiskeySockets/Baileys/issues/1718
 */
export class LidMappingService {
  private firestore: Firestore;
  private logger = pino({ name: "LidMappingService" });

  // In-memory cache: userId -> (lid -> phoneNumber)
  private lidToPhoneCache: Map<string, Map<string, string>> = new Map();
  // Reverse cache: userId -> (phoneNumber -> lid)
  private phoneToLidCache: Map<string, Map<string, string>> = new Map();

  // Track which users have been loaded from Firestore
  private loadedUsers: Set<string> = new Set();

  constructor(firestore: Firestore) {
    this.firestore = firestore;
  }

  /**
   * Get the Firestore collection path for a user's LID mappings
   */
  private getMappingsCollection(userId: string) {
    return this.firestore.collection("users").doc(userId).collection("lid_mappings");
  }

  /**
   * Load all LID mappings for a user from Firestore into memory
   * Should be called when a session connects/reconnects
   */
  async loadMappingsForUser(userId: string): Promise<number> {
    try {
      // Skip if already loaded
      if (this.loadedUsers.has(userId)) {
        this.logger.debug({ userId }, "LID mappings already loaded for user");
        return this.lidToPhoneCache.get(userId)?.size || 0;
      }

      const snapshot = await this.getMappingsCollection(userId).get();

      const lidToPhone = new Map<string, string>();
      const phoneToLid = new Map<string, string>();

      snapshot.docs.forEach((doc) => {
        const data = doc.data();
        if (data.lid && data.phone_number) {
          lidToPhone.set(data.lid, data.phone_number);
          phoneToLid.set(data.phone_number, data.lid);
        }
      });

      this.lidToPhoneCache.set(userId, lidToPhone);
      this.phoneToLidCache.set(userId, phoneToLid);
      this.loadedUsers.add(userId);

      this.logger.info({ userId, mappingCount: lidToPhone.size }, "Loaded LID mappings from Firestore");

      return lidToPhone.size;
    } catch (error) {
      this.logger.error({ userId, error }, "Failed to load LID mappings from Firestore");
      // Initialize empty caches on error
      this.lidToPhoneCache.set(userId, new Map());
      this.phoneToLidCache.set(userId, new Map());
      return 0;
    }
  }

  /**
   * Save a LID to phone number mapping
   * Updates both in-memory cache and Firestore
   */
  async saveLidMapping(userId: string, lid: string, phoneNumber: string): Promise<void> {
    try {
      // Validate inputs
      if (!lid || !phoneNumber || !lid.includes("@lid")) {
        this.logger.warn({ userId, lid, phoneNumber }, "Invalid LID mapping - skipping");
        return;
      }

      // Normalize phone number (ensure + prefix)
      const normalizedPhone = phoneNumber.startsWith("+") ? phoneNumber : `+${phoneNumber}`;

      // Check if we already have this mapping in memory
      const existingPhone = this.resolveLidToPhone(userId, lid);
      const alreadyInMemory = existingPhone === normalizedPhone;

      // Update in-memory caches (even if already there, ensure consistency)
      if (!this.lidToPhoneCache.has(userId)) {
        this.lidToPhoneCache.set(userId, new Map());
      }
      if (!this.phoneToLidCache.has(userId)) {
        this.phoneToLidCache.set(userId, new Map());
      }

      this.lidToPhoneCache.get(userId)!.set(lid, normalizedPhone);
      this.phoneToLidCache.get(userId)!.set(normalizedPhone, lid);

      // Extract numeric part of LID for document ID (remove @lid suffix)
      const docId = lid.replace("@lid", "");

      // ALWAYS persist to Firestore (handles case where user deleted mapping manually)
      // Using merge: true ensures idempotency
      this.getMappingsCollection(userId)
        .doc(docId)
        .set(
          {
            lid: lid,
            phone_number: normalizedPhone,
            created_at: admin.firestore.FieldValue.serverTimestamp(),
            updated_at: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
        .catch((error) => {
          this.logger.error({ userId, lid, phoneNumber: normalizedPhone, error }, "Failed to persist LID mapping to Firestore");
        });

      if (!alreadyInMemory) {
        this.logger.info({ userId, lid, phoneNumber: normalizedPhone }, "Saved new LID mapping");
      } else {
        this.logger.debug({ userId, lid, phoneNumber: normalizedPhone }, "Refreshed existing LID mapping in Firestore");
      }
    } catch (error) {
      this.logger.error({ userId, lid, phoneNumber, error }, "Error saving LID mapping");
    }
  }

  /**
   * Resolve a LID to its associated phone number
   * Returns null if no mapping exists
   */
  resolveLidToPhone(userId: string, lid: string): string | null {
    if (!lid || !lid.includes("@lid")) {
      return null;
    }

    const userCache = this.lidToPhoneCache.get(userId);
    if (!userCache) {
      return null;
    }

    return userCache.get(lid) || null;
  }

  /**
   * Resolve a phone number to its associated LID
   * Returns null if no mapping exists
   */
  resolvePhoneToLid(userId: string, phoneNumber: string): string | null {
    if (!phoneNumber) {
      return null;
    }

    // Normalize phone number for lookup
    const normalizedPhone = phoneNumber.startsWith("+") ? phoneNumber : `+${phoneNumber}`;

    const userCache = this.phoneToLidCache.get(userId);
    if (!userCache) {
      return null;
    }

    return userCache.get(normalizedPhone) || null;
  }

  /**
   * Capture a LID mapping from two identifiers when we detect they refer to the same person
   * (e.g., from duplicate messages with same messageId but different sender format)
   *
   * @param userId - The user ID
   * @param id1 - First identifier (could be LID or phone)
   * @param id2 - Second identifier (could be LID or phone)
   * @returns true if a new mapping was captured
   */
  async captureMappingFromPair(userId: string, id1: string, id2: string): Promise<boolean> {
    this.logger.info({ userId, id1, id2 }, "captureMappingFromPair called");

    const isLid1 = id1.includes("@lid");
    const isLid2 = id2.includes("@lid");

    // Need exactly one LID and one phone number
    if (isLid1 === isLid2) {
      this.logger.info({ userId, id1, id2, isLid1, isLid2 }, "captureMappingFromPair: both same type - skipping");
      return false;
    }

    let lid: string;
    let phone: string;

    if (isLid1) {
      lid = id1;
      phone = id2.replace("@s.whatsapp.net", "");
    } else {
      lid = id2;
      phone = id1.replace("@s.whatsapp.net", "");
    }

    // Normalize phone (ensure + prefix)
    const normalizedPhone = phone.startsWith("+") ? phone : `+${phone}`;

    this.logger.info({ userId, lid, normalizedPhone }, "captureMappingFromPair: extracted lid and phone");

    // Always save the mapping (saveLidMapping handles idempotency and always persists to Firestore)
    await this.saveLidMapping(userId, lid, normalizedPhone);

    this.logger.info({ userId, lid, phone: normalizedPhone, source: "duplicate_pair" }, "Captured LID mapping from identifier pair");

    return true;
  }

  /**
   * Get the count of loaded mappings for a user
   */
  getMappingCount(userId: string): number {
    return this.lidToPhoneCache.get(userId)?.size || 0;
  }

  /**
   * Clear mappings for a user (useful for cleanup/testing)
   */
  clearUserMappings(userId: string): void {
    this.lidToPhoneCache.delete(userId);
    this.phoneToLidCache.delete(userId);
    this.loadedUsers.delete(userId);
    this.logger.info({ userId }, "Cleared LID mappings for user");
  }

  /**
   * Check if an identifier is a LID format
   */
  static isLid(identifier: string): boolean {
    return identifier?.includes("@lid") || false;
  }

  /**
   * Check if an identifier is a regular phone JID format
   */
  static isPhoneJid(identifier: string): boolean {
    return identifier?.includes("@s.whatsapp.net") || false;
  }

  /**
   * Import multiple LID mappings at once (used when v7's native mapping store provides bulk data)
   *
   * @param userId - The user ID
   * @param mappings - Array of LID to phone number mappings
   * @returns The number of successfully imported mappings
   */
  async importMappings(userId: string, mappings: Array<{ lid: string; phoneNumber: string }>): Promise<number> {
    let imported = 0;
    for (const { lid, phoneNumber } of mappings) {
      try {
        await this.saveLidMapping(userId, lid, phoneNumber);
        imported++;
      } catch (error) {
        this.logger.warn({ userId, lid, phoneNumber, error }, "Failed to import LID mapping");
      }
    }
    return imported;
  }
}
