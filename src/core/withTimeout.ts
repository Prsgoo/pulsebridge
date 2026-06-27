import { PulseBridgeError } from "../contracts/errors/pulseErrors.js";

/**
 * Runs `task` with a timeout. The task receives an {@link AbortSignal} that is
 * aborted the moment the timeout fires, so it can cancel in-flight work (e.g.
 * `fetch`) instead of leaking the socket while the platform moves on.
 *
 * Rejects with a {@link PulseBridgeError} (`<label> timed out after <ms>ms`) on
 * timeout; otherwise resolves/rejects with whatever `task` produces. The timer
 * is always cleared, so a fast task never holds the event loop open.
 */
export function withTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new PulseBridgeError(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    task(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
