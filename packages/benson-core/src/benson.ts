import type { BensonDependencies, BensonReply, ConversationTurn, Message } from "./types.js";
import { parseIntent } from "./intent.js";
import { presentResult } from "./presenter.js";
import { processRequest } from "@clawde/secretary-core";

export function createBenson(deps: BensonDependencies): {
  handleUserMessage(message: string): Promise<BensonReply>;
  getHistory(): ConversationTurn[];
  clearHistory(): void;
} {
  const maxTurns = deps.maxHistoryTurns ?? 8;

  // Rolling conversation buffer — lives in this closure, never serialised here.
  // The app shell can persist it separately if needed (Phase 5.3 ext.).
  const history: ConversationTurn[] = [];

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
      const messageHistory = toMessageHistory();
      const parsed = parseIntent(message, messageHistory);

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

      const result = await deps.executeTask(spec);
      const text = presentResult(result, spec);

      // Append to rolling buffer (drop oldest if at cap)
      history.push({ user: message, assistant: text });
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
