import { Socket } from "node:net";

export interface GeyserClientConfig {
  host?: string;
  port?: number;
  timeoutMs?: number;
}

export interface GeyserSampleResult {
  messageCount: number;
  sampleMs: number;
}

/**
 * Lightweight health check for the Yellowstone Geyser gRPC port.
 *
 * For Phase 1.3 we only verify that we can open a TCP connection to the
 * configured host:port (default 127.0.0.1:10000). We are NOT decoding
 * real Geyser messages yet – that will come later in the actual bot.
 */
export async function checkGeyserTcp(
  config: GeyserClientConfig = {}
): Promise<void> {
  const host = config.host ?? "127.0.0.1";
  const port = config.port ?? 10000;
  const timeoutMs = config.timeoutMs ?? 2000;

  await new Promise<void>((resolve, reject) => {
    const socket = new Socket();

    const cleanup = () => {
      socket.removeAllListeners();
      if (!socket.destroyed) {
        socket.destroy();
      }
    };

    socket.once("connect", () => {
      cleanup();
      resolve();
    });

    socket.once("error", (err) => {
      cleanup();
      reject(
        new Error(
          "Failed to connect to Yellowstone Geyser at " +
          host +
          ":" +
          String(port) +
          " – " +
          (err instanceof Error ? err.message : String(err))
        )
      );
    });

    socket.setTimeout(timeoutMs, () => {
      cleanup();
      reject(
        new Error(
          "Timeout trying to connect to Yellowstone Geyser at " +
          host +
          ":" +
          String(port) +
          " after " +
          String(timeoutMs) +
          " ms"
        )
      );
    });

    socket.connect(port, host);
  });
}
