/**
 * BaileysFactory - Dual-version Baileys support
 *
 * Provides the correct Baileys module (v6 or v7) based on user preference.
 * v6 uses static CommonJS imports, v7 uses dynamic ESM imports.
 *
 * All connections default to v7 (full LID support).
 * Users can be pinned to v6 via Firestore field or env var if needed.
 */

import * as baileysV6 from "@whiskeysockets/baileys";
import pino from "pino";

const logger = pino({ name: "BaileysFactory" });

// Cache the v7 module after first dynamic import
let baileysV7Cache: typeof baileysV6 | null = null;

export type BaileysVersion = "v6" | "v7";

/**
 * The v7 package name, aliased via npm package aliasing in package.json.
 * Stored as a variable so TypeScript does not attempt static module resolution
 * on the dynamic import() call -- the package may not be installed yet during
 * development or in environments that only use v6.
 */
const BAILEYS_V7_PACKAGE = "baileys-v7";

/**
 * Get the Baileys v7 module via dynamic ESM import.
 * Cached after first load to avoid repeated imports.
 */
async function loadBaileysV7(): Promise<typeof baileysV6> {
  if (!baileysV7Cache) {
    try {
      // Dynamic import for ESM module -- uses variable to avoid static resolution
      baileysV7Cache = (await import(BAILEYS_V7_PACKAGE)) as unknown as typeof baileysV6;
      logger.info("Baileys v7 module loaded successfully");
    } catch (error) {
      logger.error({ error }, "Failed to load Baileys v7 module");
      throw new Error("Failed to load Baileys v7. Ensure baileys-v7 package is installed.");
    }
  }
  return baileysV7Cache;
}

/**
 * Get the appropriate Baileys module for the given version.
 *
 * @param version - "v6" for current stable, "v7" for new with LID support
 * @returns The Baileys module
 */
export async function getBaileys(version: BaileysVersion = "v6"): Promise<typeof baileysV6> {
  if (version === "v7") {
    return loadBaileysV7();
  }
  return baileysV6;
}

/**
 * Check if a version string indicates v7.
 */
export function isV7(version: string): boolean {
  return version === "v7";
}

/**
 * Get the session directory name for the given Baileys version.
 * v6 sessions are incompatible with v7, so they use separate directories.
 */
export function getSessionDirName(version: BaileysVersion): string {
  return version === "v7" ? "sessions-v7" : "sessions";
}

/**
 * Get the default Baileys version for new connections.
 * Can be overridden via environment variable.
 */
export function getDefaultBaileysVersion(): BaileysVersion {
  const envVersion = process.env.DEFAULT_BAILEYS_VERSION;
  if (envVersion === "v6") return "v6";
  return "v7"; // Default to v7 for full LID support
}
