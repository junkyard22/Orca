export type CargoReferenceKind = 'repository' | 'file' | 'task' | 'connector';

export interface CargoReference {
  kind: CargoReferenceKind;
  value: string;
}

export type CargoSlashCommand =
  | { name: 'repo'; argument?: string }
  | { name: 'file'; argument?: string }
  | { name: 'task'; argument?: string }
  | { name: 'connect'; argument?: string }
  | { name: 'context' }
  | { name: 'status' };

export interface CargoSyntaxResult {
  message: string;
  references: CargoReference[];
  command?: CargoSlashCommand;
}

const COMMANDS = new Set(['repo', 'file', 'task', 'connect', 'context', 'status']);

function clean(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

function stripActionVerb(command: string, argument: string): string {
  const verbPattern = command === 'file'
    ? /^(?:add|attach|open)\s+/i
    : command === 'task'
      ? /^(?:add|create)\s+/i
      : command === 'repo'
        ? /^(?:add|attach)\s+/i
        : /^attach\s+/i;
  return argument.replace(verbPattern, '').trim();
}

function parseCommand(message: string): CargoSlashCommand | undefined {
  if (message.includes('\n')) return undefined;
  const match = message.match(/^\/(repo|file|task|connect|context|status)(?:[ \t]+(.*?))?[ \t]*$/i);
  if (!match?.[1]) return undefined;
  const name = match[1].toLowerCase();
  if (!COMMANDS.has(name)) return undefined;
  if (name === 'context' || name === 'status') return { name };

  const argument = stripActionVerb(name, clean(match[2] ?? ''));
  return {
    name: name as 'repo' | 'file' | 'task' | 'connect',
    ...(argument && { argument }),
  };
}

/**
 * Parses Cargo syntax at Benson's conversation boundary.
 *
 * Resource references are deliberately line-oriented in the first slice, so
 * an ordinary sentence containing an @ mention cannot accidentally attach the
 * rest of the sentence as a path or repository name.
 */
export function parseCargoSyntax(input: string): CargoSyntaxResult {
  const normalized = clean(input);
  const command = parseCommand(normalized);
  if (command) return { message: '', references: [], command };

  const references: CargoReference[] = [];
  const messageLines: string[] = [];
  for (const line of normalized.split('\n')) {
    const match = line.match(/^\s*@(repo|file|task|connector)\s+(.+?)\s*$/i);
    if (!match?.[1] || !match[2]) {
      messageLines.push(line);
      continue;
    }

    const kind = match[1].toLowerCase() === 'repo'
      ? 'repository'
      : match[1].toLowerCase() as Exclude<CargoReferenceKind, 'repository'>;
    const value = clean(match[2]);
    if (value) references.push({ kind, value });
  }

  return {
    message: clean(messageLines.join('\n')),
    references,
  };
}

export function formatCargoAttachmentResult(labels: string[]): string {
  if (labels.length === 0) return 'No Cargo resources were attached.';
  return `Added to Cargo: ${labels.join(', ')}.`;
}

export function formatCargoCommandHelp(command: 'repo' | 'file' | 'task' | 'connect'): string {
  const examples = {
    repo: '/repo owner/name',
    file: '/file path/to/file',
    task: '/task #142 or a short task description',
    connect: '/connect connector-id',
  };
  return `Add a value after the command (for example: ${examples[command]}) or choose it from the + Cargo menu.`;
}

export function formatCargoContextResult(summary: string, lines: string[]): string {
  return lines.length > 0
    ? `${summary}\n\n${lines.map((line) => `- ${line}`).join('\n')}`
    : summary;
}

export function formatCargoStatusResult(input: {
  ready: boolean;
  summary: string;
  workspace?: string;
  connectorCount: number;
  availableToolCount: number;
}): string {
  const lines = [
    `Orca is ${input.ready ? 'ready' : 'not fully configured'}.`,
    input.summary,
    input.workspace ? `Workspace: ${input.workspace}` : 'Workspace: not configured',
    `Connectors attached: ${input.connectorCount}`,
    `Tools available: ${input.availableToolCount}`,
  ];
  return lines.join('\n');
}
