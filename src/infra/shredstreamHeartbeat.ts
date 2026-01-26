import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Returns true if UDP port 8000 appears in `ss -lun` output, false otherwise.
 * Throws if the command itself fails.
 */
export async function checkShredstreamOnce(): Promise<boolean> {
  try {
    const { stdout } = await execAsync(
      "ss -lun | egrep '(:20000\\s|:20000,)' || true"
    );

    const output = stdout ?? "";
    // Check for the new port 20000
    const has20000 = output.includes(":20000");
    return has20000;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      "Failed to run 'ss -lun' for ShredStream check: " + message
    );
  }
}
