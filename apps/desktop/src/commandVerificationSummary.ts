type ToolEvent = {
  tool: string;
  ok: boolean;
  summary: string;
  raw?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function rawCommand(event: ToolEvent): string {
  if (!isRecord(event.raw)) return "";
  const command = event.raw["command"];
  return typeof command === "string" ? command.trim() : "";
}

function rawOutput(event: ToolEvent): string {
  if (!isRecord(event.raw)) return "";
  const output = event.raw["_outputForProof"];
  return typeof output === "string" ? output.trim() : "";
}

function extractCommandsFromCriteria(doneCriteria: string[]): string[] {
  const commands = doneCriteria
    .map((criterion) => criterion.match(/\bcommand:\s*(.+)$/i)?.[1]?.trim() ?? "")
    .filter((command) => command.length > 0);
  return [...new Set(commands)];
}

function findCommandEvent(command: string, toolEvents: ToolEvent[]): ToolEvent | undefined {
  const commandEvents = toolEvents.filter((event) =>
    /(?:run_command|execute_command|shell)/i.test(event.tool) || rawCommand(event).length > 0
  );
  return commandEvents.find((event) => {
    const actual = rawCommand(event);
    if (!actual) return false;
    return actual === command || actual.includes(command) || command.includes(actual);
  });
}

function shortOutput(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 320 ? normalized : `${normalized.slice(0, 317).trimEnd()}...`;
}

export function isCommandVerificationCriteria(doneCriteria: string[]): boolean {
  return doneCriteria.some((criterion) => /\bcompletion status\b/i.test(criterion) && /\bcommand\b/i.test(criterion));
}

export function buildCommandVerificationSummary(params: {
  doneCriteria: string[];
  toolEvents: ToolEvent[];
  agentOutputText?: string;
  stoppedBecause?: string;
  errorMessage?: string;
}): string {
  const requestedCommands = extractCommandsFromCriteria(params.doneCriteria);
  const commandEvents = params.toolEvents.filter((event) =>
    /(?:run_command|execute_command|shell)/i.test(event.tool) || rawCommand(event).length > 0
  );

  const lines: string[] = ["Command verification result"];
  const missingCommands: string[] = [];
  const failedCommands: string[] = [];

  if (requestedCommands.length > 0) {
    for (const command of requestedCommands) {
      const event = findCommandEvent(command, commandEvents);
      if (!event) {
        missingCommands.push(command);
        lines.push(`Reported completion status for command: ${command} - NOT RUN`);
        continue;
      }

      const status = event.ok ? "COMPLETED" : "NON-ZERO EXIT";
      if (!event.ok) failedCommands.push(command);
      lines.push(`Reported completion status for command: ${command} - ${status}`);

      if (!event.ok) {
        lines.push(`Command output details for non-zero command exit: ${event.summary}`);
        const output = rawOutput(event);
        if (output) lines.push(`Command output excerpt: ${shortOutput(output)}`);
      }
    }
  } else if (commandEvents.length > 0) {
    for (const event of commandEvents) {
      const command = rawCommand(event) || event.tool;
      const status = event.ok ? "COMPLETED" : "NON-ZERO EXIT";
      if (!event.ok) failedCommands.push(command);
      lines.push(`Reported completion status for command: ${command} - ${status}`);
      if (!event.ok) lines.push(`Command output details for non-zero command exit: ${event.summary}`);
    }
  } else {
    lines.push("Reported completion status for each requested command - NOT RUN");
  }

  const overall = missingCommands.length > 0
    ? "INCOMPLETE"
    : failedCommands.length > 0
      ? "FAIL"
      : "PASS";
  lines.push(`Reported overall verification result: ${overall}`);

  const agentOutput = params.agentOutputText?.trim();
  if (agentOutput) {
    lines.push("", "Agent output:", agentOutput);
  } else if (params.stoppedBecause && params.stoppedBecause !== "done") {
    lines.push("", `Agent stopped before final report: ${params.stoppedBecause}`);
    if (params.errorMessage) lines.push(`Agent error: ${params.errorMessage}`);
  }

  return lines.join("\n");
}
