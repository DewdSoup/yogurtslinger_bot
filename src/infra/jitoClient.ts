import { promises as fs } from "node:fs";

export interface JitoClientConfig {
  authKeypairPath?: string;
}

/**
 * Phase 1.3 Jito check:
 * We only verify that a Jito auth keypair JSON file exists and is parseable.
 * No real Block Engine calls yet – those will be wired in a later phase.
 */
export class JitoClient {
  private constructor(public readonly keypairPath: string) { }

  static async init(config: JitoClientConfig = {}): Promise<JitoClient> {
    const authKeypairPath =
      config.authKeypairPath ??
      process.env.JITO_AUTH_KEYPAIR ??
      "/home/sol/keys/jito-bundles.json";

    let raw: string;
    try {
      raw = await fs.readFile(authKeypairPath, "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        "Failed to read Jito auth keypair file at " +
        authKeypairPath +
        ": " +
        message
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        "Jito auth keypair file " +
        authKeypairPath +
        " is not valid JSON: " +
        message
      );
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error(
        "Jito auth keypair file " +
        authKeypairPath +
        " does not look like a keypair (expected non-empty JSON array)."
      );
    }

    return new JitoClient(authKeypairPath);
  }
}
