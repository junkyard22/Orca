import type { BensonDependencies, BensonReply, ConversationTurn, Message, TaskSpec } from "./types.js";
import { parseIntent, isRetryMessage } from "./intent.js";
import { presentResult } from "./presenter.js";

export function createBenson(deps: BensonDependencies): {
  handleUserMessage(message: string): Promise<BensonReply>;
  getHistory(): ConversationTurn[];
  clearHistory(): void;
} {
  const maxTurns = deps.maxHistoryTurns ?? 8;

  function normalizeUserMessage(message: string): string {
    return message.replace(/\r\n?/g, "\n").trim();
  }

  // Rolling conversation buffer — lives in this closure, never serialised here.
  // The app shell can persist it separately if needed (Phase 5.3 ext.).
  const history: ConversationTurn[] = [];

  // Track the last successfully parsed TaskSpec so retries can re-use it.
  let lastSpec: TaskSpec | null = null;

  // Convert ConversationTurn[] to Message[] for parseIntent
  function toMessageHistory(): Message[] {
    const messages: Message[] = [];
    for (const turn of history) {
      messages.push({ role: 'user', content: turn.user });
      messages.push({ role: 'assistant', content: turn.assistant });
    }
    return messages;
  }

  return {
    async handleUserMessage(message: string): Promise<BensonReply> {
      const normalizedMessage = normalizeUserMessage(message);

      // ── Retry detection ───────────────────────────────────────────────────
      // If the user says "try again" / "retry" etc. and we have a previous
      // spec, re-run it verbatim rather than parsing a new task.
      if (isRetryMessage(normalizedMessage) && lastSpec) {
        const retrySpec: TaskSpec = {
          ...lastSpec,
          context: {
            ...(lastSpec.context ?? {}),
            conversationHistory: toMessageHistory(),
            isRetry: true,
          },
        };
        const result = await deps.executeTask(retrySpec);
        const text = presentResult(result, retrySpec);
        history.push({ user: normalizedMessage, assistant: text });
        if (history.length > maxTurns) history.shift();
        return { kind: "RESULT", text, task: retrySpec };
      }

      const messageHistory = toMessageHistory();
      const parsed = parseIntent(normalizedMessage, messageHistory);

      if (parsed.kind === "CLARIFY") {
        // Don't add clarify exchanges to history — they're noise
        return {
          kind: "CLARIFY",
          text: parsed.text,
          options: parsed.options,
        };
      }

      // parseIntent already builds the full TaskSpec with intent, goals,
      // constraints, and context (including history). Use it directly.
      const spec = parsed.spec;
      lastSpec = spec;  // remember for potential retry

      const result = await deps.executeTask(spec);
      const text = presentResult(result, spec);

      // Append to rolling buffer (drop oldest if at cap)
      history.push({ user: normalizedMessage, assistant: text });
      if (history.length > maxTurns) history.shift();

      return { kind: "RESULT", text, task: spec };
    },

    // Expose for testing and session save/restore
    getHistory(): ConversationTurn[] {
      return [...history];
    },

    clearHistory(): void {
      history.length = 0;
    },
  };
}
