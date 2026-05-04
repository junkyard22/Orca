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
  buildClarifyPrompt,
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

// Whether a pipeline result contains code blocks or is long enough that
// Claire should pass it through rather than re-voice the whole thing.
function isLongOrStructured(text: string): boolean {
  return text.includes("```") || text.length > 400;
}

// ---------------------------------------------------------------------------
// Claire factory
// ---------------------------------------------------------------------------

export function createClaire(deps: ClaireDeps): ClaireInstance {
  const maxTurns = deps.maxHistoryTurns ?? 8;
  const history: ConversationTurn[] = [];

  // ── CONVERSATIONAL ─────────────────────────────────────────────────────────
  // Claire responds directly using her character voice + full conversation context.

  async function handleConversational(
    message: string,
    signal?: AbortSignal,
  ): Promise<string> {
    throwIfAborted(signal);
    const messages: ClaireMessage[] = [
      { role: "system", content: CLAIRE_SYSTEM_PROMPT },
      ...historyToMessages(history),
      { role: "user", content: message },
    ];
    return deps.complete(messages);
  }

  // ── NEEDS_CLARIFICATION ────────────────────────────────────────────────────
  // Claire asks one targeted question in her own voice.

  async function handleClarification(
    question: string,
    signal?: AbortSignal,
  ): Promise<string> {
    throwIfAborted(signal);
    const messages: ClaireMessage[] = [
      { role: "system", content: CLAIRE_SYSTEM_PROMPT },
      { role: "user", content: buildClarifyPrompt(question) },
    ];
    return deps.complete(messages);
  }

  // ── EXECUTABLE — result presentation ──────────────────────────────────────
  // Pipeline ran. Claire delivers the result in her voice.

  async function presentResult(
    originalMessage: string,
    result: ExecutionResult,
    spec: TaskSpec,
    signal?: AbortSignal,
  ): Promise<string> {
    throwIfAborted(signal);

    // Surface any follow-up question from the executor first.
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

    // SUCCESS or WARN — build raw pipeline text first.
    const rawOutput = buildRawOutput(result, spec);

    // Pass through structured/long content unchanged but with a brief intro from Claire.
    if (isLongOrStructured(rawOutput)) {
      const messages: ClaireMessage[] = [
        { role: "system", content: CLAIRE_SYSTEM_PROMPT },
        ...historyToMessages(history),
        { role: "user", content: buildPresentPrompt(originalMessage, rawOutput) },
      ];
      return deps.complete(messages);
    }

    // Short plain-text result — re-voice fully.
    const messages: ClaireMessage[] = [
      { role: "system", content: CLAIRE_SYSTEM_PROMPT },
      ...historyToMessages(history),
      { role: "user", content: buildPresentPrompt(originalMessage, rawOutput) },
    ];
    return deps.complete(messages);
  }

  // Build raw pipeline output for presentation (mirrors benson-core presenter logic
  // but without the mechanical template wrappers — Claire will voice it herself).
  function buildRawOutput(result: ExecutionResult, _spec: TaskSpec): string {
    if (result.userFacingText?.trim()) {
      return result.userFacingText.trim();
    }

    const arts = result.artifacts as { filesChanged?: Array<{ path?: string }> } | undefined;
    if (arts?.filesChanged && arts.filesChanged.length > 0) {
      const fileList = arts.filesChanged
        .map((f) => `- ${f.path ?? "(unknown)"}`)
        .join("\n");
      return `Created or updated:\n${fileList}`;
    }

    return result.summary ?? "Task completed.";
  }

  // ── Push to history ────────────────────────────────────────────────────────

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

      if (classification.kind === "CONVERSATIONAL") {
        const reply = await handleConversational(normalized, signal);
        pushHistory(normalized, reply);
        return reply;
      }

      if (classification.kind === "NEEDS_CLARIFICATION") {
        // Don't add clarify exchanges to history — they're noise.
        return handleClarification(classification.question, signal);
      }

      // EXECUTABLE — run the pipeline, then present via Claire's voice.
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
