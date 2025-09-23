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
  unlimited?: boolean;
  error?: string;
}
export declare class LimitChecker {
  private db;
  constructor();
  /**
   * Check if a phone number is a new contact
   */
  private checkIfNewContact;
  /**
   * Reset daily counters if needed
   */
  private resetDailyCountersIfNeeded;
  /**
   * Check WhatsApp Web sending limits
   */
  checkLimits(
    userId: string,
    phoneNumber: string,
    recipientNumber: string,
  ): Promise<LimitCheckResult>;
  /**
   * Apply delay if needed
   */
  applyDelay(delayMs: number): Promise<void>;
}
//# sourceMappingURL=limitChecker.d.ts.map
