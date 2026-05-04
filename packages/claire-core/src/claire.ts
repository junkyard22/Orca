import { classifyIntent, type Message } from "@clawde/benson-core";
import type {
  ClaireDeps,
  ClaireHandleOptions,
  ClaireInstance,
  ClaireMessage,
  ConversationTurn,
  ExecutionResult,
  TaskSpec,
} from "./types.js";
import {
  CLAIRE_SYSTEM_PROMPT,
  buildFailurePrompt,
  buildPresentPrompt,
} from "./voice.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function historyToMessages(history: ConversationTurn[]): ClaireMessage[] {
  const messages: ClaireMessage[] = [];
  for (const turn of history) {
    messages.push({ role: "user", content: turn.user });
    messages.push({ role: "assistant", content: turn.assistant });
  }
  return messages;
}

function historyToClassifyMessages(history: ConversationTurn[]): Message[] {
  const messages: Message[] = [];
  for (const turn of history) {
    messages.push({ role: "user", content: turn.user });
    messages.push({ role: "assistant", content: turn.assistant });
  }
  return messages;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error(
      signal.reason instanceof Error
        ? signal.reason.message
        : typeof signal.reason === "string" && signal.reason
          ? signal.reason
          : "The operation was aborted.",
    );
    err.name = "AbortError";
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Claire factory
// ---------------------------------------------------------------------------

export function createClaire(deps: ClaireDeps): ClaireInstance {
  const maxTurns = deps.maxHistoryTurns ?? 8;
  const history: ConversationTurn[] = [];

  // ── EXECUTABLE — result presentation ──────────────────────────────────────
  // Pipeline ran. Claire re-voices the result via a direct LLM call.
  // This is the ONLY path that calls deps.complete().

  async function presentResult(
    originalMessage: string,
    result: ExecutionResult,
    spec: TaskSpec,
    signal?: AbortSignal,
  ): Promise<string> {
    throwIfAborted(signal);

    if (result.followUpQuestion) {
      return result.followUpQuestion;
    }

    if (result.status === "FAIL") {
      const summary = result.summary ?? result.userFacingText ?? "Something went wrong.";
      const messages: ClaireMessage[] = [
        { role: "system", content: CLAIRE_SYSTEM_PROMPT },
        ...historyToMessages(history),
        { role: "user", content: buildFailurePrompt(originalMessage, summary) },
      ];
      return deps.complete(messages);
    }

    // SUCCESS or WARN — build raw pipeline text then re-voice through Claire.
    const rawOutput = buildRawOutput(result, spec);
    const messages: ClaireMessage[] = [
      { role: "system", content: CLAIRE_SYSTEM_PROMPT },
      ...historyToMessages(history),
      { role: "user", content: buildPresentPrompt(originalMessage, rawOutput) },
    ];
    return deps.complete(messages);
  }

  function buildRawOutput(result: ExecutionResult, _spec: TaskSpec): string {
    if (result.userFacingText?.trim()) {
      return result.userFacingText.trim();
    }
    const arts = result.artifacts as { filesChanged?: Array<{ path?: string }> } | undefined;
    if (arts?.filesChanged && arts.filesChanged.length > 0) {
      return arts.filesChanged.map((f) => `- ${f.path ?? "(unknown)"}`).join("\n");
    }
    return result.summary ?? "Task completed.";
  }

  function pushHistory(user: string, assistant: string): void {
    history.push({ user, assistant });
    if (history.length > maxTurns) history.shift();
  }

  // ── Public handleUserMessage ───────────────────────────────────────────────

  return {
    async handleUserMessage(
      message: string,
      options?: ClaireHandleOptions,
    ): Promise<string> {
      const signal = options?.abortSignal;
      throwIfAborted(signal);

      const normalized = message.replace(/\r\n?/g, "\n").trim();
      const msgHistory = historyToClassifyMessages(history);
      const classification = classifyIntent(normalized, msgHistory);

      // ── CONVERSATIONAL — instant, no LLM call ─────────────────────────────
      // cannedResponse is always present for known patterns. If somehow absent
      // (future extensibility), fall back to a safe default rather than calling
      // the LLM — keeping conversational paths latency-free.
      if (classification.kind === "CONVERSATIONAL") {
        const reply = classification.cannedResponse ?? "Got it.";
        pushHistory(normalized, reply);
        return reply;
      }

      // ── NEEDS_CLARIFICATION — instant, no LLM call ────────────────────────
      // classifyIntent already produced a naturally-phrased question.
      // Don't call the LLM to rephrase it — that's the latency killer.
      if (classification.kind === "NEEDS_CLARIFICATION") {
        // Don't add clarify exchanges to history — they're navigational noise.
        return classification.question;
      }

      // ── EXECUTABLE — pipeline + LLM re-voice ──────────────────────────────
      const { spec } = classification;
      throwIfAborted(signal);

      const result = await deps.executeTask(spec, { abortSignal: signal });
      const reply = await presentResult(normalized, result, spec, signal);

      pushHistory(normalized, reply);
      return reply;
    },

    getHistory(): ConversationTurn[] {
      return [...history];
    },

    setHistory(turns: ConversationTurn[]): void {
      history.length = 0;
      const trimmed = turns.slice(-maxTurns);
      for (const t of trimmed) history.push(t);
    },

    clearHistory(): void {
      history.length = 0;
    },
  };
}
