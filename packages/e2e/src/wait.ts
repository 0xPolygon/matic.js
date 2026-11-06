/**
 * Poll `fn` until it returns a non-undefined value, or throw after
 * `timeoutMs`. The label names the condition in the timeout error so a
 * failed wait says what it was waiting for.
 */
export async function pollUntil<T>({
  fn,
  pollMs,
  timeoutMs,
  label
}: {
  fn: () => Promise<T | undefined>;
  pollMs: number;
  timeoutMs: number;
  label: string;
}): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${String(timeoutMs)} ms waiting for: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
