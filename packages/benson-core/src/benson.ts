import type { BensonDependencies, BensonReply, ConversationTurn } from "./types.js";
import { parseIntent } from "./intent.js";
import { presentResult } from "./presenter.js";
import { processRequest } from "@clawde/secretary-core";

export function createBenson(deps: BensonDependencies): {
  handleUserMessage(message: string): Promise<BensonReply>;
} {
  const maxTurns = deps.maxHistoryTurns ?? 8;

  // Rolling conversation buffer — lives in this closure, never serialised here.
  // The app shell can persist it separately if needed (Phase 5.3 ext.).
  const history: ConversationTurn[] = [];

  return {
    async handleUserMessage(message: string): Promise<BensonReply> {
      const parsed = parseIntent(message);

      if (parsed.kind === "CLARIFY") {
        return {
          kind: "CLARIFY",
          text: parsed.text,
          options: parsed.options,
        };
      }

      // Secretary builds the full TaskSpec: intent, goals, constraints,
      // permissions (which tools are allowed), output format, and injects
      // conversation history into context.
      const spec = processRequest(message, history);

      const result = await deps.executeTask(spec);
      const text = presentResult(result, spec);

      // Append to rolling buffer (drop oldest if at cap)
      history.push({ user: message, assistant: text });
      if (history.length > maxTurns) history.shift();

      return { kind: "RESULT", text, task: spec };
    },
  };
}
