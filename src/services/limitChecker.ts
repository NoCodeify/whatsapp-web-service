import * as admin from "firebase-admin";
import pino from "pino";

const logger = pino({ name: "LimitChecker" });

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
  admin.initializeApp({
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
  });
}

interface WhatsAppWebSettings {
  delay_between_new_messages: number;
  delay_random_variation: number;
  warning_threshold: number;
  enabled: boolean;
}

interface WhatsAppWebUsage {
  today_date: string;
  new_contacts_today: number;
  total_messages_today: number; // Actually tracks total messages sent
  last_reset: admin.firestore.Timestamp;
  monthly_new_contacts: number;
  last_message_timestamp?: admin.firestore.Timestamp;
  limit_email_sent_today?: boolean; // Prevents duplicate limit emails
}

export interface LimitCheckResult {
  allowed: boolean;
  isNewContact: boolean;
  delayMs: number;
  usage: {
    used: number;
    limit: number;
    remaining: number;
    percentage: number;
  };
  totalMessagesUsage: {
    used: number;
    limit: number;
    remaining: number;
    percentage: number;
  };
  totalMessageLimitReached: boolean;
  shouldSendLimitEmail: boolean;
  unlimited?: boolean;
  error?: string;
}

// Constants removed - daily message limit now comes from database

export class LimitChecker {
  private db: admin.firestore.Firestore;

  constructor() {
    this.db = admin.firestore();
  }

  /**
   * Check if a phone number is a new OUTBOUND-INITIATED contact
   * A contact is considered "new" for limit purposes if:
   * 1. No contact document exists (completely new), OR
   * 2. Contact exists but we've never messaged them AND they've never messaged us (dormant contact)
   *
   * A contact is NOT "new" if:
   * - We've sent them a message before (last_outgoing_message_at exists)
   * - They messaged us first (last_incoming_message_at exists but no last_outgoing_message_at)
   *   → In this case, we're just REPLYING, not initiating a new conversation
   */
  private async checkIfNewContact(
    userId: string,
    recipientNumber: string,
  ): Promise<boolean> {
    try {
      // Get user reference for querying
      const userRef = this.db.collection("users").doc(userId);

      // Check if contact exists in GLOBAL contacts collection (not subcollection!)
      const contactsQuery = await this.db
        .collection("contacts")
        .where("user", "==", userRef)
        .where("phone_number", "==", recipientNumber)
        .limit(1)
        .get();

      // If no contact found, it's a new contact
      if (contactsQuery.empty) {
        return true;
      }

      // Contact exists - check message history
      const contactData = contactsQuery.docs[0].data();
      const hasOutgoingMessages = contactData.last_outgoing_message_at != null;
      const hasIncomingMessages = contactData.last_incoming_message_at != null;

      // If we've sent them messages before, not a new contact
      if (hasOutgoingMessages) {
        return false;
      }

      // If they've messaged us first but we haven't replied yet,
      // this is NOT a new contact - we're just replying (not initiating)
      if (hasIncomingMessages && !hasOutgoingMessages) {
        return false;
      }

      // Contact exists but no message history - treat as new contact
      return true;
    } catch (error) {
      logger.error(
        { error, userId, recipientNumber },
        "Error checking if new contact",
      );
      // Default to treating as NOT new contact for safety (to avoid over-counting)
      return false;
    }
  }

  /**
   * Reset daily counters if needed
   */
  private resetDailyCountersIfNeeded(
    usage: WhatsAppWebUsage,
  ): WhatsAppWebUsage {
    const today = new Date().toISOString().split("T")[0];

    if (usage.today_date !== today) {
      logger.info(
        { oldDate: usage.today_date, newDate: today },
        "Resetting daily counters",
      );
      return {
        ...usage,
        today_date: today,
        new_contacts_today: 0,
        total_messages_today: 0,
        limit_email_sent_today: false,
        last_reset: admin.firestore.Timestamp.now(),
      };
    }

    return usage;
  }

  /**
   * Sanitize counter values to ensure they are valid non-negative integers
   * Handles edge cases: negative numbers, NaN, strings, Infinity, etc.
   */
  private sanitizeCounter(value: any): number {
    const num = Number(value);

    // Check for invalid numbers (NaN, Infinity, negative)
    if (!Number.isFinite(num) || num < 0) {
      return 0;
    }

    // Ensure integer (no decimals)
    return Math.floor(num);
  }

  /**
   * Check WhatsApp Web sending limits
   * Uses Firestore transactions for atomic read-modify-write to prevent race conditions
   */
  async checkLimits(
    userId: string,
    phoneNumber: string,
    recipientNumber: string,
  ): Promise<LimitCheckResult> {
    // Get user settings (outside transaction to avoid timeout)
    const userDoc = await this.db.collection("users").doc(userId).get();

    if (!userDoc.exists) {
      logger.warn({ userId }, "User not found");
      return {
        allowed: false,
        isNewContact: false,
        delayMs: 0,
        error: "User not found",
        usage: {
          used: 0,
          limit: 0,
          remaining: 0,
          percentage: 0,
        },
        totalMessagesUsage: {
          used: 0,
          limit: 250, // Use hardcoded fallback since we can't access phone doc
          remaining: 250,
          percentage: 0,
        },
        totalMessageLimitReached: false,
        shouldSendLimitEmail: false,
      };
    }

    const userData = userDoc.data();
    const settings: WhatsAppWebSettings = userData?.whatsapp_web_settings || {
      delay_between_new_messages: 45,
      delay_random_variation: 30,
      warning_threshold: 0.8,
      enabled: true,
    };

    // If limits are disabled, allow unlimited
    if (!settings.enabled) {
      logger.info({ userId, phoneNumber }, "Limits disabled for user");
      return {
        allowed: true,
        unlimited: true,
        isNewContact: false,
        delayMs: 0,
        usage: {
          used: 0,
          limit: 25,
          remaining: 25,
          percentage: 0,
        },
        totalMessagesUsage: {
          used: 0,
          limit: 250, // Use hardcoded fallback since we haven't fetched phone doc yet
          remaining: 250,
          percentage: 0,
        },
        totalMessageLimitReached: false,
        shouldSendLimitEmail: false,
      };
    }

    // Check if new contact OUTSIDE transaction to avoid timeout
    const isNewContact = await this.checkIfNewContact(userId, recipientNumber);

    // Use transaction for atomic read-modify-write
    const phoneDocRef = this.db
      .collection("users")
      .doc(userId)
      .collection("phone_numbers")
      .doc(phoneNumber);

    try {
      const result = await this.db.runTransaction(async (transaction) => {
        const phoneDoc = await transaction.get(phoneDocRef);

        if (!phoneDoc.exists) {
          throw new Error("Phone number not found");
        }

        const phoneData = phoneDoc.data();

        let usage: WhatsAppWebUsage = phoneData?.whatsapp_web_usage || {
          today_date: new Date().toISOString().split("T")[0],
          new_contacts_today: 0,
          total_messages_today: 0,
          last_reset: admin.firestore.Timestamp.now(),
          monthly_new_contacts: 0,
        };

        // CRITICAL: Sanitize all counters to prevent data corruption (BUG #1, #2, #3 fix)
        usage.new_contacts_today = this.sanitizeCounter(
          usage.new_contacts_today,
        );
        usage.total_messages_today = this.sanitizeCounter(
          usage.total_messages_today,
        );
        usage.monthly_new_contacts = this.sanitizeCounter(
          usage.monthly_new_contacts,
        );

        // Also sanitize the daily limit (BUG #4 fix)
        const dailyLimit = Math.max(
          1,
          this.sanitizeCounter(phoneData?.messaging_limit) || 25,
        );
        const monthlyLimit = dailyLimit * 20; // Approximate monthly limit based on daily

        // Get daily message limit from phone document (BUG #5 fix - make it database-driven)
        const dailyMessageLimit = Math.max(
          1,
          this.sanitizeCounter(phoneData?.daily_message_limit) || 250,
        );

        // Reset daily counters if needed
        usage = this.resetDailyCountersIfNeeded(usage);

        // Check limits BEFORE incrementing (critical for correctness)
        if (isNewContact) {
          if (usage.new_contacts_today >= dailyLimit) {
            logger.warn(
              {
                userId,
                phoneNumber,
                used: usage.new_contacts_today,
                limit: dailyLimit,
              },
              "Daily limit reached",
            );

            // Calculate total message usage even when new contact limit reached
            const totalMessagesUsed = usage.total_messages_today || 0;
            const totalMessageLimitReached =
              totalMessagesUsed >= dailyMessageLimit;

            return {
              allowed: false,
              isNewContact: true,
              delayMs: 0,
              error: `Daily limit of ${dailyLimit} new contacts reached`,
              usage: {
                used: usage.new_contacts_today,
                limit: dailyLimit,
                remaining: 0,
                percentage: 100,
              },
              totalMessagesUsage: {
                used: totalMessagesUsed,
                limit: dailyMessageLimit,
                remaining: Math.max(0, dailyMessageLimit - totalMessagesUsed),
                percentage: Math.min(
                  100,
                  (totalMessagesUsed / dailyMessageLimit) * 100,
                ),
              },
              totalMessageLimitReached,
              shouldSendLimitEmail: false, // Don't send email for new contact limit
            };
          }

          // Check monthly limit
          if (usage.monthly_new_contacts >= monthlyLimit) {
            logger.warn(
              {
                userId,
                phoneNumber,
                used: usage.monthly_new_contacts,
                limit: monthlyLimit,
              },
              "Monthly limit reached",
            );

            // Calculate total message usage even when monthly limit reached
            const totalMessagesUsed = usage.total_messages_today || 0;
            const totalMessageLimitReached =
              totalMessagesUsed >= dailyMessageLimit;

            return {
              allowed: false,
              isNewContact: true,
              delayMs: 0,
              error: `Monthly limit of ${monthlyLimit} new contacts reached`,
              usage: {
                used: usage.new_contacts_today,
                limit: dailyLimit,
                remaining: 0,
                percentage: 100,
              },
              totalMessagesUsage: {
                used: totalMessagesUsed,
                limit: dailyMessageLimit,
                remaining: Math.max(0, dailyMessageLimit - totalMessagesUsed),
                percentage: Math.min(
                  100,
                  (totalMessagesUsed / dailyMessageLimit) * 100,
                ),
              },
              totalMessageLimitReached,
              shouldSendLimitEmail: false, // Don't send email for monthly limit
            };
          }

          // Safe increment: sanitize before adding (prevents string concatenation)
          usage.new_contacts_today =
            this.sanitizeCounter(usage.new_contacts_today) + 1;
          usage.monthly_new_contacts =
            this.sanitizeCounter(usage.monthly_new_contacts) + 1;
        }

        // Safe increment: sanitize before adding (prevents string concatenation)
        usage.total_messages_today =
          this.sanitizeCounter(usage.total_messages_today) + 1;
        usage.last_message_timestamp = admin.firestore.Timestamp.now();

        // Atomic update within transaction
        transaction.update(phoneDocRef, {
          whatsapp_web_usage: usage,
        });

        // No delay applied - send messages immediately
        const delayMs = 0;

        // Calculate usage stats for new contacts
        const remaining = dailyLimit - usage.new_contacts_today;
        const percentage = (usage.new_contacts_today / dailyLimit) * 100;

        // Calculate total message usage stats
        const totalMessagesUsed = usage.total_messages_today;
        const totalMessageLimitReached =
          totalMessagesUsed >= dailyMessageLimit;
        const shouldSendEmail =
          totalMessageLimitReached && !usage.limit_email_sent_today;
        const totalMessagesRemaining = Math.max(
          0,
          dailyMessageLimit - totalMessagesUsed,
        );
        const totalMessagesPercentage = Math.min(
          100,
          (totalMessagesUsed / dailyMessageLimit) * 100,
        );

        logger.info(
          {
            userId,
            phoneNumber,
            recipientNumber,
            isNewContact,
            newContactsUsed: usage.new_contacts_today,
            totalMessagesUsed,
            totalMessageLimitReached,
          },
          "Limit check passed",
        );

        return {
          allowed: true,
          isNewContact,
          delayMs: Math.round(delayMs),
          usage: {
            used: usage.new_contacts_today,
            limit: dailyLimit,
            remaining: Math.max(0, remaining),
            percentage: Math.min(100, percentage),
          },
          totalMessagesUsage: {
            used: totalMessagesUsed,
            limit: dailyMessageLimit,
            remaining: totalMessagesRemaining,
            percentage: totalMessagesPercentage,
          },
          totalMessageLimitReached,
          shouldSendLimitEmail: shouldSendEmail,
        };
      });

      return result;
    } catch (error) {
      logger.error({ error, userId, phoneNumber }, "Error checking limits");

      // Only catch validation errors - allow them through gracefully
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (errorMessage?.includes("not found")) {
        return {
          allowed: false,
          isNewContact: false,
          delayMs: 0,
          error: errorMessage,
          usage: {
            used: 0,
            limit: 0,
            remaining: 0,
            percentage: 0,
          },
          totalMessagesUsage: {
            used: 0,
            limit: 250, // Use hardcoded fallback since we can't access phone doc
            remaining: 250,
            percentage: 0,
          },
          totalMessageLimitReached: false,
          shouldSendLimitEmail: false,
        };
      }

      // Re-throw database errors - don't allow on DB failure
      // This prevents silent failures where counters increment in memory
      // but database update fails, incorrectly returning "allowed: true"
      throw error;
    }
  }

  /**
   * Apply delay if needed (DEPRECATED - no longer applies delays)
   */
  async applyDelay(_delayMs: number): Promise<void> {
    // Delay functionality has been removed - messages now send immediately
    return Promise.resolve();
  }
}
