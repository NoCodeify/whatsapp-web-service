import parsePhoneNumberFromString, { CountryCode } from "libphonenumber-js";
import pino from "pino";

const logger = pino({ name: "PhoneNumberUtils" });

export interface ParsedPhoneNumber {
  e164: string;
  countryCode: string;
  nationalNumber: string;
  country?: CountryCode;
  isValid: boolean;
  isPossible: boolean;
}

/**
 * Parse and format a phone number to E.164 format
 * This handles common formatting issues like leading zeros after country codes
 *
 * @param phoneNumber - The phone number to parse (can include country code)
 * @param defaultCountry - Optional default country code if number doesn't include country code
 * @returns Formatted E.164 phone number or null if invalid
 */
export function formatPhoneNumber(
  phoneNumber: string,
  defaultCountry?: CountryCode,
): string | null {
  try {
    // Clean the input - remove spaces, dashes, parentheses, etc.
    let cleaned = phoneNumber.replace(/[\s\-\(\)\.]/g, "");

    // If it doesn't start with +, add it (assuming it's an international number)
    if (cleaned.length > 0 && !cleaned.startsWith("+")) {
      // If we have a default country and the number doesn't look international
      if (defaultCountry && !cleaned.startsWith("00")) {
        // Try parsing with the default country
        const parsed = parsePhoneNumberFromString(cleaned, defaultCountry);
        if (parsed && parsed.isValid()) {
          return parsed.number as string;
        }
      }

      // Otherwise, assume it's missing the + sign
      cleaned = "+" + cleaned;
    }

    // Parse the phone number
    const parsed = parsePhoneNumberFromString(cleaned);

    if (!parsed) {
      // If parsing failed and we have a default country, try with that
      if (defaultCountry) {
        const parsedWithCountry = parsePhoneNumberFromString(
          phoneNumber,
          defaultCountry,
        );
        if (parsedWithCountry && parsedWithCountry.isValid()) {
          return parsedWithCountry.number as string;
        }
      }

      logger.warn(
        { phoneNumber, defaultCountry },
        "Failed to parse phone number",
      );
      return null;
    }

    // Check if it's valid
    if (!parsed.isValid()) {
      logger.warn(
        {
          phoneNumber,
          parsed: parsed.number,
          country: parsed.country,
          isPossible: parsed.isPossible(),
        },
        "Phone number is not valid",
      );

      // Even if not fully valid, if it's possible, return the formatted version
      // This helps with some edge cases where the number is technically correct
      if (parsed.isPossible()) {
        return parsed.number as string;
      }

      return null;
    }

    // Return E.164 formatted number
    return parsed.number as string;
  } catch (error) {
    logger.error({ phoneNumber, error }, "Error formatting phone number");
    return null;
  }
}

/**
 * Parse a phone number and return detailed information
 *
 * @param phoneNumber - The phone number to parse
 * @param defaultCountry - Optional default country code
 * @returns Parsed phone number details or null if invalid
 */
export function parsePhoneNumber(
  phoneNumber: string,
  defaultCountry?: CountryCode,
): ParsedPhoneNumber | null {
  try {
    // Use the formatter to clean and validate
    const formatted = formatPhoneNumber(phoneNumber, defaultCountry);
    if (!formatted) {
      return null;
    }

    // Parse the formatted number for details
    const parsed = parsePhoneNumberFromString(formatted);
    if (!parsed) {
      return null;
    }

    return {
      e164: parsed.number as string,
      countryCode: parsed.countryCallingCode.toString(),
      nationalNumber: parsed.nationalNumber,
      country: parsed.country,
      isValid: parsed.isValid(),
      isPossible: parsed.isPossible(),
    };
  } catch (error) {
    logger.error({ phoneNumber, error }, "Error parsing phone number");
    return null;
  }
}

/**
 * Format a phone number for WhatsApp JID
 * WhatsApp requires E.164 format without the + sign
 *
 * @param phoneNumber - The phone number to format
 * @param defaultCountry - Optional default country code
 * @returns WhatsApp JID format (e.g., "31658015937@s.whatsapp.net")
 */
export function formatWhatsAppJid(
  phoneNumber: string,
  defaultCountry?: CountryCode,
): string | null {
  const formatted = formatPhoneNumber(phoneNumber, defaultCountry);
  if (!formatted) {
    return null;
  }

  // Remove the + sign and add WhatsApp suffix
  const withoutPlus = formatted.substring(1);
  return `${withoutPlus}@s.whatsapp.net`;
}

/**
 * Validate if a phone number is valid
 *
 * @param phoneNumber - The phone number to validate
 * @param defaultCountry - Optional default country code
 * @returns True if valid, false otherwise
 */
export function isValidPhoneNumber(
  phoneNumber: string,
  defaultCountry?: CountryCode,
): boolean {
  const formatted = formatPhoneNumber(phoneNumber, defaultCountry);
  return formatted !== null;
}

/**
 * Extract country code from a phone number
 *
 * @param phoneNumber - The phone number to parse
 * @returns Country code or null if not found
 */
export function getCountryCode(phoneNumber: string): CountryCode | null {
  try {
    const parsed = parsePhoneNumberFromString(phoneNumber);
    return parsed?.country || null;
  } catch {
    return null;
  }
}

/**
 * Common problematic patterns and their corrections
 * This is specifically for handling common user input errors
 */
export function preprocessPhoneNumber(phoneNumber: string): string {
  let processed = phoneNumber.trim();

  // Handle common country-specific patterns with leading zeros
  const patterns = [
    // Netherlands: +31 0 -> +31
    { pattern: /^\+31\s*0/, replacement: "+31" },
    // France: +33 0 -> +33
    { pattern: /^\+33\s*0/, replacement: "+33" },
    // Germany: +49 0 -> +49
    { pattern: /^\+49\s*0/, replacement: "+49" },
    // Belgium: +32 0 -> +32
    { pattern: /^\+32\s*0/, replacement: "+32" },
    // Italy: +39 0 -> +39
    { pattern: /^\+39\s*0/, replacement: "+39" },
    // Spain: +34 0 -> +34
    { pattern: /^\+34\s*0/, replacement: "+34" },
    // Switzerland: +41 0 -> +41
    { pattern: /^\+41\s*0/, replacement: "+41" },
    // Austria: +43 0 -> +43
    { pattern: /^\+43\s*0/, replacement: "+43" },
    // Poland: +48 0 -> +48
    { pattern: /^\+48\s*0/, replacement: "+48" },
    // Portugal: +351 0 -> +351
    { pattern: /^\+351\s*0/, replacement: "+351" },
  ];

  for (const { pattern, replacement } of patterns) {
    if (pattern.test(processed)) {
      processed = processed.replace(pattern, replacement);
      logger.debug(
        {
          original: phoneNumber,
          processed,
          pattern: pattern.toString(),
        },
        "Preprocessed phone number to remove leading zero",
      );
      break;
    }
  }

  return processed;
}

/**
 * Format a phone number with preprocessing for common errors
 * This is the main function to use for user input
 *
 * @param phoneNumber - The phone number to format
 * @param defaultCountry - Optional default country code
 * @returns Formatted E.164 phone number or null if invalid
 */
export function formatPhoneNumberSafe(
  phoneNumber: string,
  defaultCountry?: CountryCode,
): string | null {
  // First preprocess to fix common errors
  const preprocessed = preprocessPhoneNumber(phoneNumber);

  // Then format normally
  return formatPhoneNumber(preprocessed, defaultCountry);
}
