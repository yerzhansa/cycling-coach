function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

/**
 * Stop waiting for an untrusted dependency when the operation is aborted.
 *
 * The dependency promise remains observed after an abort, so a late rejection
 * cannot become unhandled. Listing the work promise first also lets a result
 * that reached its commit point synchronously win over an abort raised by that
 * same work.
 */
export async function awaitWithSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}
