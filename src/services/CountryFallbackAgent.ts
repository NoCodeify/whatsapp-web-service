import Anthropic from "@anthropic-ai/sdk";
import pino from "pino";
import { secretManager } from "../config/secrets";

const MAX_RETRIES = 3;
const BASE_DELAY = 5000; // 5 seconds

/**
 * AI Agent for intelligent country fallback selection
 * Uses Claude Haiku for cost-effective, fast geographic proximity suggestions
 */
export class CountryFallbackAgent {
  private logger = pino({ name: "CountryFallbackAgent" });
  private anthropicClient?: Anthropic;
  private initializationPromise: Promise<void>;

  constructor() {
    // Initialize Anthropic client asynchronously
    this.initializationPromise = this.initializeClient();
  }

  /**
   * Initialize Anthropic client with API key from Secret Manager
   */
  private async initializeClient(): Promise<void> {
    try {
      // Try to get API key from Secret Manager
      const apiKey = await secretManager.getAnthropicApiKey();

      this.anthropicClient = new Anthropic({
        apiKey,
        timeout: 30000, // 30 second timeout
      });

      this.logger.info("Anthropic client initialized successfully from Secret Manager");
    } catch (error: any) {
      this.logger.error({ error: error.message }, "Failed to initialize from Secret Manager, trying environment variable");

      // Fallback to environment variable
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error("No Anthropic API key available in Secret Manager or environment");
      }

      this.anthropicClient = new Anthropic({
        apiKey,
        timeout: 30000,
      });

      this.logger.warn("Anthropic client initialized from environment variable");
    }
  }

  /**
   * Ensure client is initialized before use
   */
  private async ensureInitialized(): Promise<void> {
    await this.initializationPromise;
    if (!this.anthropicClient) {
      throw new Error("Anthropic client not initialized");
    }
  }

  /**
   * Retry logic with exponential backoff (matching Cloud Functions pattern)
   */
  private async retryAnthropicCall<T>(fn: () => Promise<T>): Promise<T> {
    this.logger.info("Attempting Anthropic API call");

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await fn();
        this.logger.info({ attempt }, "Anthropic API call succeeded");
        return result;
      } catch (error: any) {
        if (error.response?.data?.error) {
          const { type, message } = error.response.data.error;
          this.logger.error({ attempt, maxRetries: MAX_RETRIES, type, message }, `Anthropic API error (attempt ${attempt}/${MAX_RETRIES})`);
        } else {
          this.logger.error({ attempt, maxRetries: MAX_RETRIES, error: error.message }, `Unexpected error (attempt ${attempt}/${MAX_RETRIES})`);
        }

        if (attempt === MAX_RETRIES) {
          throw error;
        }

        // Exponential backoff
        const waitTime = BASE_DELAY * Math.pow(2, attempt - 1);
        this.logger.info({ waitTime }, "Waiting before retry");
        await this.delay(waitTime);
      }
    }

    throw new Error("This should never be reached");
  }

  /**
   * Get the next best country code based on geographic proximity
   * @param originalCountry The original requested country code
   * @param unavailableCountries List of country codes that are already known to be unavailable
   * @returns The 2-letter country code for the best alternative
   */
  async getNextBestCountry(originalCountry: string, unavailableCountries: string[] = []): Promise<string> {
    await this.ensureInitialized();

    this.logger.info({ originalCountry, unavailableCountries }, "Requesting country fallback from AI agent");

    return this.retryAnthropicCall(async () => {
      const unavailableList = unavailableCountries.length > 0 ? unavailableCountries.join(", ") : "None";

      const response = await this.anthropicClient!.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 64,
        temperature: 0,
        system:
          "You will help find alternative country codes based on geographical proximity when proxy servers are not available for certain countries.\n" +
          "Your task is to provide the 2-letter country code for the geographically closest alternative to the original country code. Consider factors like:\n" +
          "- Physical proximity and shared borders\n" +
          "- Regional proximity within the same continent\n" +
          "- Similar time zones when countries are equidistant\n\n" +
          "Important rules:\n" +
          "- Respond with ONLY the 2-letter country code\n" +
          "- Do not include any explanation, reasoning, or additional text\n" +
          "- Do not suggest any country codes that appear in the unavailable_codes list\n" +
          "- Use standard ISO 3166-1 alpha-2 country codes\n" +
          "- If multiple countries are equally close geographically, choose the one that is most commonly used for proxy services (US, GB, DE, NL, FR, CA are preferred)\n\n" +
          "Examples:\n" +
          "- If given 'FR' (France), you might respond 'DE' (Germany)\n" +
          "- If given 'JP' (Japan), you might respond 'KR' (South Korea)\n" +
          "- If given 'US' (United States), you might respond 'CA' (Canada)\n\n" +
          "Provide only the 2-letter country code as your response.",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "\nHere is the original country code that needs an alternative:\n" +
                  `<country_code>\n${originalCountry.toUpperCase()}\n</country_code>\n\n` +
                  "Here are any country codes that are already known to be unavailable (if any):\n" +
                  `<unavailable_codes>\n${unavailableList}\n</unavailable_codes>\n`,
              },
            ],
          },
        ],
      });

      // Extract the country code from the response
      const content = response.content[0];
      if (content.type !== "text") {
        throw new Error("Unexpected response type from Anthropic");
      }

      const countryCode = content.text.trim().toUpperCase();

      // Validate it's a 2-letter code
      if (!/^[A-Z]{2}$/.test(countryCode)) {
        this.logger.error({ countryCode, originalCountry }, "Invalid country code received from AI");
        throw new Error(`Invalid country code received: ${countryCode}`);
      }

      // Ensure it's not in the unavailable list
      if (unavailableCountries.includes(countryCode.toLowerCase())) {
        this.logger.error({ countryCode, unavailableCountries }, "AI suggested an unavailable country");
        throw new Error(`AI suggested unavailable country: ${countryCode}`);
      }

      this.logger.info(
        {
          originalCountry,
          suggestedCountry: countryCode,
          unavailableCountries,
        },
        "AI agent suggested country fallback"
      );

      return countryCode.toLowerCase();
    });
  }

  /**
   * Helper to delay execution
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
