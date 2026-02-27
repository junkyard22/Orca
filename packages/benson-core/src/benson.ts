import type { BensonDependencies, BensonReply } from "./types.js";
import { parseIntent } from "./intent.js";
import { presentResult } from "./presenter.js";

export function createBenson(deps: BensonDependencies): {
  handleUserMessage(message: string): Promise<BensonReply>;
} {
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
      const result = await deps.executeTask(spec);
      const text = presentResult(result, spec);

      return { kind: "RESULT", text, task: spec };
    },
  };
}
