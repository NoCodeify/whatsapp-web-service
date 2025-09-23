import { CountryCode } from "libphonenumber-js";
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
export declare function formatPhoneNumber(
  phoneNumber: string,
  defaultCountry?: CountryCode,
): string | null;
/**
 * Parse a phone number and return detailed information
 *
 * @param phoneNumber - The phone number to parse
 * @param defaultCountry - Optional default country code
 * @returns Parsed phone number details or null if invalid
 */
export declare function parsePhoneNumber(
  phoneNumber: string,
  defaultCountry?: CountryCode,
): ParsedPhoneNumber | null;
/**
 * Format a phone number for WhatsApp JID
 * WhatsApp requires E.164 format without the + sign
 *
 * @param phoneNumber - The phone number to format
 * @param defaultCountry - Optional default country code
 * @returns WhatsApp JID format (e.g., "31658015937@s.whatsapp.net")
 */
export declare function formatWhatsAppJid(
  phoneNumber: string,
  defaultCountry?: CountryCode,
): string | null;
/**
 * Validate if a phone number is valid
 *
 * @param phoneNumber - The phone number to validate
 * @param defaultCountry - Optional default country code
 * @returns True if valid, false otherwise
 */
export declare function isValidPhoneNumber(
  phoneNumber: string,
  defaultCountry?: CountryCode,
): boolean;
/**
 * Extract country code from a phone number
 *
 * @param phoneNumber - The phone number to parse
 * @returns Country code or null if not found
 */
export declare function getCountryCode(phoneNumber: string): CountryCode | null;
/**
 * Common problematic patterns and their corrections
 * This is specifically for handling common user input errors
 */
export declare function preprocessPhoneNumber(phoneNumber: string): string;
/**
 * Format a phone number with preprocessing for common errors
 * This is the main function to use for user input
 *
 * @param phoneNumber - The phone number to format
 * @param defaultCountry - Optional default country code
 * @returns Formatted E.164 phone number or null if invalid
 */
export declare function formatPhoneNumberSafe(
  phoneNumber: string,
  defaultCountry?: CountryCode,
): string | null;
//# sourceMappingURL=phoneNumber.d.ts.map
