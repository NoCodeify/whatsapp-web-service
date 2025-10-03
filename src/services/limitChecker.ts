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
  total_contacts_today: number; // Actually tracks total messages sent
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

// Constants
const DAILY_MESSAGE_LIMIT = 250;

export class LimitChecker {
  private db: admin.firestore.Firestore;

  constructor() {
    this.db = admin.firestore();
  }

  /**
   * Check if a phone number is a new contact
   */
  private async checkIfNewContact(
    userId: string,
    recipientNumber: string,
  ): Promise<boolean> {
    try {
      // Clean the phone number
      const cleanNumber = recipientNumber.replace(/\D/g, "");

      // Check if contact exists
      const contactsQuery = await this.db
        .collection("users")
        .doc(userId)
        .collection("contacts")
        .where("phone", "==", cleanNumber)
        .limit(1)
        .get();

      return contactsQuery.empty;
    } catch (error) {
      logger.error(
        { error, userId, recipientNumber },
        "Error checking if new contact",
      );
      // Default to treating as new contact for safety
      return true;
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
        total_contacts_today: 0,
        limit_email_sent_today: false,
        last_reset: admin.firestore.Timestamp.now(),
      };
    }

    return usage;
  }

  /**
   * Check WhatsApp Web sending limits
   */
  async checkLimits(
    userId: string,
    phoneNumber: string,
    recipientNumber: string,
  ): Promise<LimitCheckResult> {
    try {
      // Get user settings
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
            limit: DAILY_MESSAGE_LIMIT,
            remaining: DAILY_MESSAGE_LIMIT,
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
            limit: DAILY_MESSAGE_LIMIT,
            remaining: DAILY_MESSAGE_LIMIT,
            percentage: 0,
          },
          totalMessageLimitReached: false,
          shouldSendLimitEmail: false,
        };
      }

      // Get phone number document
      const phoneDoc = await this.db
        .collection("users")
        .doc(userId)
        .collection("phone_numbers")
        .doc(phoneNumber)
        .get();

      if (!phoneDoc.exists) {
        logger.warn({ userId, phoneNumber }, "Phone number not found");
        return {
          allowed: false,
          isNewContact: false,
          delayMs: 0,
          error: "Phone number not found",
          usage: {
            used: 0,
            limit: 0,
            remaining: 0,
            percentage: 0,
          },
          totalMessagesUsage: {
            used: 0,
            limit: DAILY_MESSAGE_LIMIT,
            remaining: DAILY_MESSAGE_LIMIT,
            percentage: 0,
          },
          totalMessageLimitReached: false,
          shouldSendLimitEmail: false,
        };
      }

      const phoneData = phoneDoc.data();

      // Get the daily limit from phone number document, default to 25
      const dailyLimit = phoneData?.messaging_limit || 25;
      const monthlyLimit = dailyLimit * 20; // Approximate monthly limit based on daily

      let usage: WhatsAppWebUsage = phoneData?.whatsapp_web_usage || {
        today_date: new Date().toISOString().split("T")[0],
        new_contacts_today: 0,
        total_contacts_today: 0,
        last_reset: admin.firestore.Timestamp.now(),
        monthly_new_contacts: 0,
      };

      // Reset daily counters if needed
      usage = this.resetDailyCountersIfNeeded(usage);

      // Check if this is a new contact
      const isNewContact = await this.checkIfNewContact(
        userId,
        recipientNumber,
      );

      // Check limits for new contacts
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
          const totalMessagesUsed = usage.total_contacts_today || 0;
          const totalMessageLimitReached =
            totalMessagesUsed >= DAILY_MESSAGE_LIMIT;

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
              limit: DAILY_MESSAGE_LIMIT,
              remaining: Math.max(0, DAILY_MESSAGE_LIMIT - totalMessagesUsed),
              percentage: Math.min(
                100,
                (totalMessagesUsed / DAILY_MESSAGE_LIMIT) * 100,
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
          const totalMessagesUsed = usage.total_contacts_today || 0;
          const totalMessageLimitReached =
            totalMessagesUsed >= DAILY_MESSAGE_LIMIT;

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
              limit: DAILY_MESSAGE_LIMIT,
              remaining: Math.max(0, DAILY_MESSAGE_LIMIT - totalMessagesUsed),
              percentage: Math.min(
                100,
                (totalMessagesUsed / DAILY_MESSAGE_LIMIT) * 100,
              ),
            },
            totalMessageLimitReached,
            shouldSendLimitEmail: false, // Don't send email for monthly limit
          };
        }

        // Update counters for new contact
        usage.new_contacts_today++;
        usage.monthly_new_contacts++;
      }

      // Update total contacts counter
      usage.total_contacts_today++;
      usage.last_message_timestamp = admin.firestore.Timestamp.now();

      // Save updated usage
      await phoneDoc.ref.update({
        whatsapp_web_usage: usage,
      });

      // No delay applied - send messages immediately
      let delayMs = 0;

      // Calculate usage stats for new contacts
      const remaining = dailyLimit - usage.new_contacts_today;
      const percentage = (usage.new_contacts_today / dailyLimit) * 100;

      // Calculate total message usage stats
      const totalMessagesUsed = usage.total_contacts_today;
      const totalMessageLimitReached = totalMessagesUsed >= DAILY_MESSAGE_LIMIT;
      const shouldSendEmail =
        totalMessageLimitReached && !usage.limit_email_sent_today;
      const totalMessagesRemaining = Math.max(
        0,
        DAILY_MESSAGE_LIMIT - totalMessagesUsed,
      );
      const totalMessagesPercentage = Math.min(
        100,
        (totalMessagesUsed / DAILY_MESSAGE_LIMIT) * 100,
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
          limit: DAILY_MESSAGE_LIMIT,
          remaining: totalMessagesRemaining,
          percentage: totalMessagesPercentage,
        },
        totalMessageLimitReached,
        shouldSendLimitEmail: shouldSendEmail,
      };
    } catch (error) {
      logger.error({ error, userId, phoneNumber }, "Error checking limits");

      // On error, allow sending but without delay
      return {
        allowed: true,
        isNewContact: false,
        delayMs: 0,
        error: "Failed to check limits",
        usage: {
          used: 0,
          limit: 25,
          remaining: 25,
          percentage: 0,
        },
        totalMessagesUsage: {
          used: 0,
          limit: DAILY_MESSAGE_LIMIT,
          remaining: DAILY_MESSAGE_LIMIT,
          percentage: 0,
        },
        totalMessageLimitReached: false,
        shouldSendLimitEmail: false,
      };
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
