import type { LLMRequest } from "../pipeline/types.js";

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

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }
}

export function createRequestSignal(
  request: Pick<LLMRequest, "signal" | "maxTokens">,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const externalSignal = request.signal;

  if (!externalSignal) {
    return { signal: timeoutSignal, cleanup: () => undefined };
  }

  if (typeof AbortSignal.any === "function") {
    return {
      signal: AbortSignal.any([externalSignal, timeoutSignal]),
      cleanup: () => undefined,
    };
  }

  const controller = new AbortController();
  const forwardAbort = (source: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(source.reason ?? createAbortError());
    }
  };
  const onExternalAbort = () => forwardAbort(externalSignal);
  const onTimeoutAbort = () => forwardAbort(timeoutSignal);

  if (externalSignal.aborted) {
    forwardAbort(externalSignal);
  } else {
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  timeoutSignal.addEventListener("abort", onTimeoutAbort, { once: true });

  return {
    signal: controller.signal,
    cleanup: () => {
      externalSignal.removeEventListener("abort", onExternalAbort);
      timeoutSignal.removeEventListener("abort", onTimeoutAbort);
    },
  };
}
