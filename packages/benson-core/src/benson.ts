import type { BensonDependencies, BensonReply, ConversationTurn, TaskSpec } from "./types.js";
import { parseIntent } from "./intent.js";
import { presentResult } from "./presenter.js";

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

      const { spec } = parsed;

      // Inject history into context so Maestro/agents can resolve references
      // like "that endpoint" or "do the same for the other component".
      const specWithHistory: TaskSpec =
        history.length > 0
          ? {
              ...spec,
              context: {
                ...spec.context,
                conversationHistory: history.map((t) => ({
                  user:      t.user,
                  assistant: t.assistant,
                })),
              },
            }
          : spec;

      const result = await deps.executeTask(specWithHistory);
      const text = presentResult(result, spec);

      // Append to rolling buffer (drop oldest if at cap)
      history.push({ user: message, assistant: text });
      if (history.length > maxTurns) history.shift();

      return { kind: "RESULT", text, task: spec };
    },
  };
}
