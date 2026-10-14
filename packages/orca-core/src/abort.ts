export function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error && reason.name === "AbortError") {
    return reason;
  }
  const error = new Error(
    reason instanceof Error
      ? reason.message
      : typeof reason === "string" && reason.length > 0
        ? reason
        : "The operation was aborted.",
  );
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }
}

/**
 * Resolve with `promise`, or reject with an AbortError as soon as `signal`
 * aborts — without waiting for the promise. The underlying work keeps running
 * and must be tracked by the task lifecycle; its late result is ignored here.
 */
export function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(createAbortError(signal.reason));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(createAbortError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}
