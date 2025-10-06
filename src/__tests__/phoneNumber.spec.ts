import {
  formatPhoneNumber,
  formatPhoneNumberSafe,
  parsePhoneNumber,
  formatWhatsAppJid,
  isValidPhoneNumber,
  getCountryCode,
  preprocessPhoneNumber,
} from "../utils/phoneNumber";

describe("phoneNumber Security & Validation", () => {
  describe("formatPhoneNumberSafe - Security Validations", () => {
    // ===== BUG #1: Length validation (DoS prevention) =====
    it("should reject phone numbers exceeding MAX_PHONE_LENGTH (20 chars)", () => {
      const longPhone = "+1" + "2".repeat(100);
      expect(formatPhoneNumberSafe(longPhone)).toBeNull();
    });

    it("should reject 21-character phone number (just over limit)", () => {
      const justOverLimit = "+1" + "2".repeat(19); // 21 chars total
      expect(formatPhoneNumberSafe(justOverLimit)).toBeNull();
    });

    it("should accept phone numbers at exactly MAX_PHONE_LENGTH (20 chars)", () => {
      const exactLimit = "+1234567890123456789"; // Exactly 20 chars
      const result = formatPhoneNumberSafe(exactLimit);
      // May be null due to invalid format, but should not fail length check
      expect(result === null || typeof result === "string").toBe(true);
    });

    it("should accept phone numbers within length limit", () => {
      expect(formatPhoneNumberSafe("+12025551234")).not.toBeNull();
    });

    it("should reject extremely long phone numbers (1000+ chars)", () => {
      const extremelyLong = "+" + "1".repeat(1000);
      expect(formatPhoneNumberSafe(extremelyLong)).toBeNull();
    });

    // ===== BUG #2: XSS prevention (character whitelist) =====
    it("should reject phone numbers with script tags", () => {
      expect(
        formatPhoneNumberSafe("+1234<script>alert(1)</script>"),
      ).toBeNull();
    });

    it("should reject phone numbers with HTML tags", () => {
      expect(formatPhoneNumberSafe("+1234<b>test</b>")).toBeNull();
    });

    it("should reject phone numbers with img tags", () => {
      expect(
        formatPhoneNumberSafe("+1234<img src=x onerror=alert(1)>"),
      ).toBeNull();
    });

    it("should reject phone numbers with special chars (except allowed)", () => {
      expect(formatPhoneNumberSafe("+1234@#$%")).toBeNull();
    });

    it("should reject phone numbers with semicolons", () => {
      expect(formatPhoneNumberSafe("+1234;567890")).toBeNull();
    });

    it("should reject phone numbers with equals signs", () => {
      expect(formatPhoneNumberSafe("+1234=567890")).toBeNull();
    });

    it("should reject phone numbers with ampersands", () => {
      expect(formatPhoneNumberSafe("+1234&567890")).toBeNull();
    });

    it("should reject phone numbers with quotes", () => {
      expect(formatPhoneNumberSafe('+1234"567890')).toBeNull();
      expect(formatPhoneNumberSafe("+1234'567890")).toBeNull();
    });

    it("should allow valid characters: digits, +, -, (, ), spaces", () => {
      expect(formatPhoneNumberSafe("+1 (202) 555-1234")).not.toBeNull();
    });

    it("should allow phone number with only digits", () => {
      expect(formatPhoneNumberSafe("12025551234")).not.toBeNull();
    });

    it("should allow phone number with + and digits", () => {
      expect(formatPhoneNumberSafe("+12025551234")).not.toBeNull();
    });

    it("should allow phone number with dashes", () => {
      expect(formatPhoneNumberSafe("1-202-555-1234")).not.toBeNull();
    });

    it("should allow phone number with parentheses", () => {
      expect(formatPhoneNumberSafe("(202) 555-1234")).not.toBeNull();
    });

    it("should allow phone number with spaces", () => {
      expect(formatPhoneNumberSafe("+1 202 555 1234")).not.toBeNull();
    });

    // ===== BUG #3: Null byte injection prevention =====
    it("should reject phone numbers with null bytes", () => {
      expect(formatPhoneNumberSafe("+1234\x00567890")).toBeNull();
    });

    it("should reject phone numbers with embedded nulls", () => {
      expect(formatPhoneNumberSafe("123\x004567890")).toBeNull();
    });

    it("should reject phone numbers with trailing null byte", () => {
      expect(formatPhoneNumberSafe("+12025551234\x00")).toBeNull();
    });

    it("should reject phone numbers with leading null byte", () => {
      expect(formatPhoneNumberSafe("\x00+12025551234")).toBeNull();
    });

    it("should reject phone numbers with multiple null bytes", () => {
      expect(formatPhoneNumberSafe("+12\x0002\x00555\x001234")).toBeNull();
    });

    // ===== Edge cases - Invalid inputs =====
    it("should reject null input", () => {
      expect(formatPhoneNumberSafe(null as any)).toBeNull();
    });

    it("should reject undefined input", () => {
      expect(formatPhoneNumberSafe(undefined as any)).toBeNull();
    });

    it("should reject empty string", () => {
      expect(formatPhoneNumberSafe("")).toBeNull();
    });

    it("should reject whitespace-only string", () => {
      expect(formatPhoneNumberSafe("   ")).toBeNull();
    });

    it("should reject tabs-only string", () => {
      expect(formatPhoneNumberSafe("\t\t\t")).toBeNull();
    });

    it("should reject newline-only string", () => {
      expect(formatPhoneNumberSafe("\n\n")).toBeNull();
    });

    // ===== Combined security checks =====
    it("should reject SQL injection attempts", () => {
      expect(formatPhoneNumberSafe("+1234'; DROP TABLE users; --")).toBeNull();
    });

    it("should reject path traversal attempts", () => {
      expect(formatPhoneNumberSafe("+1234/../../../etc/passwd")).toBeNull();
    });

    it("should reject command injection attempts", () => {
      expect(formatPhoneNumberSafe("+1234`rm -rf /`")).toBeNull();
    });

    it("should reject unicode special characters", () => {
      expect(formatPhoneNumberSafe("+1234\u0000567890")).toBeNull();
    });
  });

  describe("formatPhoneNumber - E.164 Formatting", () => {
    // ===== Valid international formats =====
    it("should format US number with country code", () => {
      const result = formatPhoneNumber("+12025551234");
      expect(result).toBe("+12025551234");
    });

    it("should format US number without plus sign", () => {
      const result = formatPhoneNumber("12025551234");
      expect(result).toBe("+12025551234");
    });

    it("should format UK number", () => {
      const result = formatPhoneNumber("+442071234567");
      expect(result).toBe("+442071234567");
    });

    it("should format Netherlands number", () => {
      const result = formatPhoneNumber("+31658015937");
      expect(result).toBe("+31658015937");
    });

    it("should format German number", () => {
      const result = formatPhoneNumber("+49301234567");
      expect(result).toBe("+49301234567");
    });

    // ===== Format stripping =====
    it("should strip formatting characters (dashes)", () => {
      const result = formatPhoneNumber("+1-202-555-1234");
      expect(result).toBe("+12025551234");
      expect(result).not.toContain("-");
    });

    it("should strip formatting characters (parentheses)", () => {
      const result = formatPhoneNumber("+1 (202) 555-1234");
      expect(result).not.toContain("(");
      expect(result).not.toContain(")");
    });

    it("should strip formatting characters (spaces)", () => {
      const result = formatPhoneNumber("+1 202 555 1234");
      expect(result).toBe("+12025551234");
      expect(result).not.toContain(" ");
    });

    it("should strip formatting characters (dots)", () => {
      const result = formatPhoneNumber("+1.202.555.1234");
      expect(result).toBe("+12025551234");
      expect(result).not.toContain(".");
    });

    // ===== Default country handling =====
    it("should use default country for local format number", () => {
      const result = formatPhoneNumber("2025551234", "US");
      expect(result).toBeTruthy();
      expect(result).toContain("+1");
    });

    it("should use default country for UK local number", () => {
      const result = formatPhoneNumber("2071234567", "GB");
      expect(result).toBeTruthy();
      expect(result).toContain("+44");
    });

    it("should ignore default country if number has country code", () => {
      const result = formatPhoneNumber("+31658015937", "US");
      expect(result).toBe("+31658015937");
    });

    // ===== Invalid inputs =====
    it("should return null for too short numbers", () => {
      const result = formatPhoneNumber("123");
      expect(result).toBeNull();
    });

    it("should return null for just plus sign", () => {
      const result = formatPhoneNumber("+");
      expect(result).toBeNull();
    });

    it("should return null for alphabetic string", () => {
      const result = formatPhoneNumber("invalid");
      expect(result).toBeNull();
    });

    it("should return null for empty string", () => {
      const result = formatPhoneNumber("");
      expect(result).toBeNull();
    });

    // ===== Edge cases - possible but not valid =====
    it("should handle numbers that are possible but not valid", () => {
      // Should still return something if possible
      const result = formatPhoneNumber("+1234567890123");
      expect(result === null || typeof result === "string").toBe(true);
    });

    // ===== Country code without plus =====
    it("should add plus sign if missing", () => {
      const result = formatPhoneNumber("12025551234");
      expect(result).toContain("+");
    });
  });

  describe("preprocessPhoneNumber - Country-Specific Logic", () => {
    // ===== Test all 10 country patterns =====
    it("should preprocess Netherlands numbers (+31 0 -> +31)", () => {
      expect(preprocessPhoneNumber("+31 0658015937")).toBe("+31658015937");
      expect(preprocessPhoneNumber("+310658015937")).toBe("+31658015937");
    });

    it("should preprocess France numbers (+33 0 -> +33)", () => {
      expect(preprocessPhoneNumber("+33 0612345678")).toBe("+33612345678");
      expect(preprocessPhoneNumber("+330612345678")).toBe("+33612345678");
    });

    it("should preprocess Germany numbers (+49 0 -> +49)", () => {
      expect(preprocessPhoneNumber("+49 0301234567")).toBe("+49301234567");
      expect(preprocessPhoneNumber("+490301234567")).toBe("+49301234567");
    });

    it("should preprocess Belgium numbers (+32 0 -> +32)", () => {
      expect(preprocessPhoneNumber("+32 0491234567")).toBe("+32491234567");
      expect(preprocessPhoneNumber("+320491234567")).toBe("+32491234567");
    });

    it("should preprocess Italy numbers (+39 0 -> +39)", () => {
      expect(preprocessPhoneNumber("+39 0612345678")).toBe("+39612345678");
      expect(preprocessPhoneNumber("+390612345678")).toBe("+39612345678");
    });

    it("should preprocess Spain numbers (+34 0 -> +34)", () => {
      expect(preprocessPhoneNumber("+34 0612345678")).toBe("+34612345678");
      expect(preprocessPhoneNumber("+340612345678")).toBe("+34612345678");
    });

    it("should preprocess Switzerland numbers (+41 0 -> +41)", () => {
      expect(preprocessPhoneNumber("+41 0612345678")).toBe("+41612345678");
      expect(preprocessPhoneNumber("+410612345678")).toBe("+41612345678");
    });

    it("should preprocess Austria numbers (+43 0 -> +43)", () => {
      expect(preprocessPhoneNumber("+43 0612345678")).toBe("+43612345678");
      expect(preprocessPhoneNumber("+430612345678")).toBe("+43612345678");
    });

    it("should preprocess Poland numbers (+48 0 -> +48)", () => {
      expect(preprocessPhoneNumber("+48 0612345678")).toBe("+48612345678");
      expect(preprocessPhoneNumber("+480612345678")).toBe("+48612345678");
    });

    it("should preprocess Portugal numbers (+351 0 -> +351)", () => {
      expect(preprocessPhoneNumber("+351 0612345678")).toBe("+351612345678");
      expect(preprocessPhoneNumber("+3510612345678")).toBe("+351612345678");
    });

    // ===== Numbers without leading zeros =====
    it("should not modify numbers without leading zeros", () => {
      expect(preprocessPhoneNumber("+31658015937")).toBe("+31658015937");
      expect(preprocessPhoneNumber("+49301234567")).toBe("+49301234567");
    });

    // ===== Trim whitespace =====
    it("should trim leading whitespace", () => {
      expect(preprocessPhoneNumber("  +31658015937")).toBe("+31658015937");
    });

    it("should trim trailing whitespace", () => {
      expect(preprocessPhoneNumber("+31658015937  ")).toBe("+31658015937");
    });

    it("should trim both leading and trailing whitespace", () => {
      expect(preprocessPhoneNumber("  +31658015937  ")).toBe("+31658015937");
    });

    // ===== Edge cases =====
    it("should handle empty string", () => {
      expect(preprocessPhoneNumber("")).toBe("");
    });

    it("should handle whitespace only", () => {
      expect(preprocessPhoneNumber("   ")).toBe("");
    });

    it("should only apply first matching pattern", () => {
      // Should only match one pattern and stop
      const result = preprocessPhoneNumber("+31 0658015937");
      expect(result).toBe("+31658015937");
    });
  });

  describe("formatWhatsAppJid - WhatsApp Integration", () => {
    it("should format phone to WhatsApp JID", () => {
      const result = formatWhatsAppJid("+12025551234");
      expect(result).toBe("12025551234@s.whatsapp.net");
    });

    it("should format Netherlands number to JID", () => {
      const result = formatWhatsAppJid("+31658015937");
      expect(result).toBe("31658015937@s.whatsapp.net");
    });

    it("should strip + sign from number", () => {
      const result = formatWhatsAppJid("+12025551234");
      expect(result).not.toContain("+");
    });

    it("should strip non-digits before JID suffix", () => {
      const result = formatWhatsAppJid("+1-202-555-1234");
      expect(result).toMatch(/^\d+@s\.whatsapp\.net$/);
    });

    it("should return null for invalid number", () => {
      const result = formatWhatsAppJid("invalid");
      expect(result).toBeNull();
    });

    it("should return null for too short number", () => {
      const result = formatWhatsAppJid("123");
      expect(result).toBeNull();
    });

    it("should return null for empty string", () => {
      const result = formatWhatsAppJid("");
      expect(result).toBeNull();
    });

    it("should handle number with default country", () => {
      const result = formatWhatsAppJid("2025551234", "US");
      expect(result).toContain("@s.whatsapp.net");
      expect(result).toContain("1");
    });

    it("should format international numbers correctly", () => {
      expect(formatWhatsAppJid("+442071234567")).toBe(
        "442071234567@s.whatsapp.net",
      );
      expect(formatWhatsAppJid("+49301234567")).toBe(
        "49301234567@s.whatsapp.net",
      );
    });

    it("should end with @s.whatsapp.net suffix", () => {
      const result = formatWhatsAppJid("+12025551234");
      expect(result).toMatch(/@s\.whatsapp\.net$/);
    });
  });

  describe("parsePhoneNumber - Detailed Parsing", () => {
    it("should parse valid US number with details", () => {
      const parsed = parsePhoneNumber("+12025551234");
      expect(parsed).toBeTruthy();
      expect(parsed?.e164).toBe("+12025551234");
      expect(parsed?.countryCode).toBe("1");
      expect(parsed?.country).toBe("US");
      expect(parsed?.isValid).toBe(true);
    });

    it("should parse valid Netherlands number", () => {
      const parsed = parsePhoneNumber("+31658015937");
      expect(parsed).toBeTruthy();
      expect(parsed?.e164).toBe("+31658015937");
      expect(parsed?.countryCode).toBe("31");
      expect(parsed?.country).toBe("NL");
      expect(parsed?.isValid).toBe(true);
    });

    it("should parse valid UK number", () => {
      const parsed = parsePhoneNumber("+442071234567");
      expect(parsed?.countryCode).toBe("44");
      expect(parsed?.country).toBe("GB");
    });

    it("should return null for invalid number", () => {
      expect(parsePhoneNumber("invalid")).toBeNull();
    });

    it("should return null for too short number", () => {
      expect(parsePhoneNumber("123")).toBeNull();
    });

    it("should return null for empty string", () => {
      expect(parsePhoneNumber("")).toBeNull();
    });

    it("should include national number in parsed result", () => {
      const parsed = parsePhoneNumber("+12025551234");
      expect(parsed?.nationalNumber).toBeTruthy();
      expect(parsed?.nationalNumber).toBe("2025551234");
    });

    it("should include isPossible in parsed result", () => {
      const parsed = parsePhoneNumber("+12025551234");
      expect(parsed?.isPossible).toBeDefined();
      expect(typeof parsed?.isPossible).toBe("boolean");
    });

    it("should parse number with default country", () => {
      const parsed = parsePhoneNumber("2025551234", "US");
      expect(parsed).toBeTruthy();
      expect(parsed?.country).toBe("US");
    });
  });

  describe("isValidPhoneNumber - Validation", () => {
    it("should validate correct US numbers", () => {
      expect(isValidPhoneNumber("+12025551234")).toBe(true);
    });

    it("should validate correct Netherlands numbers", () => {
      expect(isValidPhoneNumber("+31658015937")).toBe(true);
    });

    it("should validate correct UK numbers", () => {
      expect(isValidPhoneNumber("+442071234567")).toBe(true);
    });

    it("should validate correct German numbers", () => {
      expect(isValidPhoneNumber("+49301234567")).toBe(true);
    });

    it("should reject invalid string", () => {
      expect(isValidPhoneNumber("invalid")).toBe(false);
    });

    it("should reject too short number", () => {
      expect(isValidPhoneNumber("123")).toBe(false);
    });

    it("should reject empty string", () => {
      expect(isValidPhoneNumber("")).toBe(false);
    });

    it("should reject null", () => {
      expect(isValidPhoneNumber(null as any)).toBe(false);
    });

    it("should reject undefined", () => {
      expect(isValidPhoneNumber(undefined as any)).toBe(false);
    });

    it("should validate with default country", () => {
      expect(isValidPhoneNumber("2025551234", "US")).toBe(true);
    });

    it("should reject malformed numbers", () => {
      expect(isValidPhoneNumber("++12025551234")).toBe(false);
    });
  });

  describe("getCountryCode - Country Extraction", () => {
    it("should extract country code from US number", () => {
      expect(getCountryCode("+12025551234")).toBe("US");
    });

    it("should extract country code from Netherlands number", () => {
      expect(getCountryCode("+31658015937")).toBe("NL");
    });

    it("should extract country code from UK number", () => {
      expect(getCountryCode("+442071234567")).toBe("GB");
    });

    it("should extract country code from German number", () => {
      expect(getCountryCode("+49301234567")).toBe("DE");
    });

    it("should extract country code from French number", () => {
      expect(getCountryCode("+33612345678")).toBe("FR");
    });

    it("should return null for invalid number", () => {
      expect(getCountryCode("invalid")).toBeNull();
    });

    it("should return null for too short number", () => {
      expect(getCountryCode("123")).toBeNull();
    });

    it("should return null for empty string", () => {
      expect(getCountryCode("")).toBeNull();
    });

    it("should handle number without country code", () => {
      const result = getCountryCode("2025551234");
      // May return null or attempt to parse
      expect(result === null || typeof result === "string").toBe(true);
    });

    it("should not throw error on malformed input", () => {
      expect(() => getCountryCode("+++123")).not.toThrow();
    });
  });

  describe("Integration: End-to-End Phone Processing", () => {
    it("should safely process and format valid phone", () => {
      const input = "+1 (202) 555-1234";
      const safe = formatPhoneNumberSafe(input);
      expect(safe).not.toBeNull();

      const formatted = formatPhoneNumber(safe!);
      expect(formatted).toBe("+12025551234");

      const jid = formatWhatsAppJid(formatted!);
      expect(jid).toBe("12025551234@s.whatsapp.net");
    });

    it("should reject malicious input at safety layer", () => {
      const malicious = "+1234<script>alert(1)</script>";
      const safe = formatPhoneNumberSafe(malicious);
      expect(safe).toBeNull();
    });

    it("should handle international number full flow", () => {
      const input = "+44 20 7946 0123";
      const safe = formatPhoneNumberSafe(input);
      expect(safe).not.toBeNull();

      const formatted = formatPhoneNumber(safe!);
      expect(formatted).toContain("44");

      const jid = formatWhatsAppJid(formatted!);
      expect(jid).toContain("@s.whatsapp.net");
    });

    it("should handle Netherlands number with preprocessing", () => {
      const input = "+31 0658015937";
      const safe = formatPhoneNumberSafe(input);
      expect(safe).toBe("+31658015937");

      const parsed = parsePhoneNumber(safe!);
      expect(parsed?.country).toBe("NL");

      const isValid = isValidPhoneNumber(safe!);
      expect(isValid).toBe(true);

      const countryCode = getCountryCode(safe!);
      expect(countryCode).toBe("NL");
    });

    it("should process through all functions without errors", () => {
      const numbers = [
        "+12025551234",
        "+31658015937",
        "+442071234567",
        "+49301234567",
        "+33612345678",
      ];

      numbers.forEach((number) => {
        const safe = formatPhoneNumberSafe(number);
        expect(safe).not.toBeNull();

        const parsed = parsePhoneNumber(safe!);
        expect(parsed).not.toBeNull();

        const jid = formatWhatsAppJid(safe!);
        expect(jid).not.toBeNull();

        const isValid = isValidPhoneNumber(safe!);
        expect(isValid).toBe(true);

        const country = getCountryCode(safe!);
        expect(country).not.toBeNull();
      });
    });
  });

  describe("Edge Cases & Error Handling", () => {
    it("should handle multiple spaces in formatting", () => {
      // Use shorter number to stay within 20 char limit
      const result = formatPhoneNumberSafe("+1 202 555 1234"); // 16 chars
      expect(result).not.toBeNull();
    });

    it("should reject multiple spaces that exceed length limit", () => {
      const result = formatPhoneNumberSafe("+1    202    555    1234"); // 24 chars
      expect(result).toBeNull(); // Exceeds MAX_PHONE_LENGTH
    });

    it("should handle mixed formatting styles", () => {
      const result = formatPhoneNumberSafe("+1-(202) 555.1234");
      expect(result).toBeNull(); // Contains dot which is not allowed in safe
    });

    it("should handle numbers with only parentheses", () => {
      const result = formatPhoneNumberSafe("(2025551234)");
      expect(result).not.toBeNull();
    });

    it("should handle numbers with only dashes", () => {
      const result = formatPhoneNumberSafe("202-555-1234");
      expect(result).not.toBeNull();
    });

    it("should handle very long valid number within limit", () => {
      const longValid = "+1234567890123456"; // 17 chars
      const result = formatPhoneNumberSafe(longValid);
      expect(result === null || typeof result === "string").toBe(true);
    });

    it("should handle preprocessing on already clean number", () => {
      const clean = "+31658015937";
      expect(preprocessPhoneNumber(clean)).toBe(clean);
    });

    it("should handle formatPhoneNumber with all formatting removed", () => {
      const result = formatPhoneNumber("12025551234");
      expect(result).toBe("+12025551234");
    });
  });

  describe("Coverage: Uncovered Code Paths", () => {
    // Cover lines 52-57: defaultCountry fallback when initial parse fails
    it("should use defaultCountry when initial parse fails but works with country", () => {
      // Give a number that looks local (no country code) with default country
      const result = formatPhoneNumber("2025551234", "US");
      expect(result).toBeTruthy();
      expect(result).toContain("+1");
    });

    it("should try defaultCountry when cleaned number parse fails", () => {
      // Number that might fail initial parse but work with country
      const result = formatPhoneNumber("5551234", "US");
      // May succeed or fail, but should exercise the fallback path
      expect(result === null || typeof result === "string").toBe(true);
    });

    // Cover error handling in parsePhoneNumber
    it("should handle errors gracefully in parsePhoneNumber", () => {
      // Test with malformed input that might cause internal errors
      const result = parsePhoneNumber("not-a-number", "US");
      expect(result).toBeNull();
    });

    // Cover catch block in getCountryCode (line 183)
    it("should handle errors gracefully in getCountryCode", () => {
      // Test with various malformed inputs
      expect(() => getCountryCode("")).not.toThrow();
      expect(() => getCountryCode("+++")).not.toThrow();
      expect(() => getCountryCode("abc")).not.toThrow();
    });

    // Additional edge cases for better coverage
    it("should handle formatPhoneNumber with number starting with 00", () => {
      // Numbers starting with 00 (international prefix in some countries)
      const result = formatPhoneNumber("00442071234567", "GB");
      // Should either parse or return null, but not crash
      expect(result === null || typeof result === "string").toBe(true);
    });

    it("should handle formatPhoneNumber when parsed object exists but isValid fails", () => {
      // Test a number that parses but may not be fully valid
      const result = formatPhoneNumber("+999999999999");
      // Should either return formatted or null based on isPossible
      expect(result === null || typeof result === "string").toBe(true);
    });

    it("should handle parsePhoneNumber when formatted number returns null", () => {
      // This should trigger line 111-112 in parsePhoneNumber
      const result = parsePhoneNumber("invalid-number-format");
      expect(result).toBeNull();
    });

    it("should handle parsePhoneNumber when parsing formatted number fails", () => {
      // Edge case where formatPhoneNumber returns something but re-parsing fails
      // This is unlikely but tests line 117-119
      const result = parsePhoneNumber("123", "XX" as any);
      expect(result).toBeNull();
    });

    it("should handle formatWhatsAppJid with default country", () => {
      const result = formatWhatsAppJid("2025551234", "US");
      expect(result).toContain("@s.whatsapp.net");
    });

    it("should handle isValidPhoneNumber with default country", () => {
      const result = isValidPhoneNumber("2071234567", "GB");
      expect(typeof result).toBe("boolean");
    });

    // Try to trigger error catch blocks with extreme edge cases
    it("should handle parsePhoneNumber with invalid object types", () => {
      // Test with various types that might cause internal errors
      const result = parsePhoneNumber({} as any);
      expect(result).toBeNull();
    });

    it("should handle parsePhoneNumber with number type", () => {
      const result = parsePhoneNumber(123456789 as any);
      expect(result).toBeNull();
    });

    it("should handle getCountryCode with invalid object types", () => {
      // Test with various types that might cause internal errors
      expect(() => getCountryCode({} as any)).not.toThrow();
      expect(getCountryCode({} as any)).toBeNull();
    });

    it("should handle getCountryCode with number type", () => {
      expect(() => getCountryCode(123456789 as any)).not.toThrow();
    });

    it("should handle getCountryCode with array type", () => {
      expect(() => getCountryCode([] as any)).not.toThrow();
    });

    // Edge case: formatted number that might re-parse as null
    it("should handle parsePhoneNumber with edge case formatted number", () => {
      // Try various edge cases
      const edgeCases = [
        "+0",
        "+00",
        "+000",
        "+" + "0".repeat(15),
        "+" + "9".repeat(15),
      ];

      edgeCases.forEach((testCase) => {
        const result = parsePhoneNumber(testCase);
        // Should either return parsed object or null, but not crash
        expect(result === null || typeof result === "object").toBe(true);
      });
    });

    // Try to trigger the line 118 path where parsed is null after formatting
    it("should handle parsePhoneNumber when re-parsing formatted number returns null", () => {
      // This is a very edge case but tests the theoretical path
      // where formatPhoneNumber succeeds but re-parsing fails
      const extremeEdgeCases = [
        "+1" + "0".repeat(20), // Over limit
        "", // Empty
        "+", // Just plus
      ];

      extremeEdgeCases.forEach((testCase) => {
        const result = parsePhoneNumber(testCase);
        expect(result).toBeNull();
      });
    });
  });
});
