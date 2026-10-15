/**
 * Shell redirection, as the shell that will actually run the command reads it.
 *
 * run_command spawns with `shell: true`: on Windows that is cmd.exe (ComSpec),
 * elsewhere /bin/sh. Git Bash and PowerShell are only involved when the
 * command itself starts them (`bash -c "…"`, `powershell -Command "…"`); their
 * inline scripts are read with their own rules.
 *
 * Found in live rehearsal A6: `npm test 2>&1` was recorded as creating a file
 * named "&1". `2>&1` duplicates a stream; it writes no file.
 *
 * What this module reports, per redirection:
 *   file        a path the shell will open for writing (create/truncate/append)
 *   device      a null or console device (nul, /dev/null, $null, …): no file
 *   descriptor  a stream duplicated onto another (2>&1, 1>&2, *>&1): no file
 *   unresolved  a target the shell expands at run time ($VAR, %VAR%, globs,
 *               process substitution, a missing target, a write cmdlet):
 *               no filename is invented; callers treat it conservatively and
 *               rely on what the host observes on disk.
 * Text inside quotes is an argument, not a redirection — except when it is an
 * inline script handed to a nested shell, which is parsed as that shell would.
 */

export type ShellDialect = "cmd" | "posix" | "powershell";

export type RedirectEffect =
  | { kind: "file"; target: string; fd: string; append: boolean; dialect: ShellDialect }
  | { kind: "device"; target: string; fd: string; dialect: ShellDialect }
  | { kind: "descriptor"; fd: string; to: string; dialect: ShellDialect }
  | { kind: "unresolved"; text: string; reason: string; dialect: ShellDialect };

/** The dialect run_command's spawn (`shell: true`) uses on this platform. */
export function runCommandShellDialect(platform: NodeJS.Platform = process.platform): ShellDialect {
  return platform === "win32" ? "cmd" : "posix";
}

type Word = { value: string; expandable: boolean; quoted: boolean };
type Token = { type: "word"; word: Word } | { type: "control"; value: string };

const CMD_DEVICES = /^(nul|con|prn|aux|com[1-9]|lpt[1-9])(\..*)?:?$/i;
const POSIX_DEVICES = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;

/**
 * Parse `command` as `dialect` does and list its redirections (including those
 * of inline scripts handed to nested shells). Never throws.
 */
export function parseRedirections(command: string, dialect: ShellDialect, depth = 0): RedirectEffect[] {
  try {
    const { tokens, effects } = scan(command, dialect);
    if (depth < 3) effects.push(...nestedScriptEffects(tokens, depth));
    return effects;
  } catch (error) {
    return [{ kind: "unresolved", text: command.slice(0, 120), reason: `could not parse: ${error instanceof Error ? error.message : String(error)}`, dialect }];
  }
}

/** Single pass over the command: words, control operators, and redirections. */
function scan(input: string, dialect: ShellDialect): { tokens: Token[]; effects: RedirectEffect[] } {
  const tokens: Token[] = [];
  const effects: RedirectEffect[] = [];
  let i = 0;
  const n = input.length;
  const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";
  const controlChars = dialect === "posix" ? ";|&()" : dialect === "cmd" ? "&|()" : ";|&(){}";
  const escapeChar = dialect === "posix" ? "\\" : dialect === "cmd" ? "^" : "`";

  /** Read one word starting at i; stops at whitespace, control, or redirection characters outside quotes. */
  const readWord = (): Word | null => {
    let value = "";
    let expandable = false;
    let quoted = false;
    let any = false;
    while (i < n) {
      const c = input[i]!;
      if (isSpace(c) || controlChars.includes(c) || c === ">" || c === "<") break;
      any = true;
      if (c === escapeChar && i + 1 < n) { value += input[i + 1]; i += 2; continue; }
      if (dialect === "posix" && c === "'") {
        const end = input.indexOf("'", i + 1); if (end < 0) throw new Error("unterminated single quote");
        value += input.slice(i + 1, end); quoted = true; i = end + 1; continue;
      }
      if (dialect === "powershell" && c === "'") {
        let j = i + 1; let s = "";
        for (;;) { if (j >= n) throw new Error("unterminated single quote"); if (input[j] === "'" && input[j + 1] === "'") { s += "'"; j += 2; continue; } if (input[j] === "'") break; s += input[j]; j += 1; }
        value += s; quoted = true; i = j + 1; continue;
      }
      if (c === "\"") {
        let j = i + 1; let s = "";
        for (;;) {
          if (j >= n) throw new Error("unterminated double quote");
          const d = input[j]!;
          if (d === "\"") break;
          if (dialect === "posix" && d === "\\" && j + 1 < n && "\"\\$`\n".includes(input[j + 1]!)) { s += input[j + 1]; j += 2; continue; }
          if (dialect === "powershell" && d === "`" && j + 1 < n) { s += input[j + 1]; j += 2; continue; }
          if ((dialect !== "cmd" && (d === "$" || d === "`")) || (dialect === "cmd" && (d === "%" || d === "!"))) expandable = true;
          s += d; j += 1;
        }
        value += s; quoted = true; i = j + 1; continue;
      }
      if (dialect === "posix" && c === "$" && input[i + 1] === "(") {
        // Command substitution: its own redirections are real; read it as a nested command.
        let depth = 0; let j = i + 1;
        for (; j < n; j += 1) { if (input[j] === "(") depth += 1; else if (input[j] === ")") { depth -= 1; if (depth === 0) break; } }
        if (j >= n) throw new Error("unterminated $(");
        effects.push(...parseRedirections(input.slice(i + 2, j), "posix", 1));
        expandable = true; value += input.slice(i, j + 1); i = j + 1; continue;
      }
      if ((dialect === "posix" && (c === "$" || c === "`" || c === "*" || c === "?" || c === "[" || c === "{" || (c === "~" && value === ""))) ||
          (dialect === "cmd" && (c === "%" || c === "!" || c === "*" || c === "?")) ||
          (dialect === "powershell" && (c === "$" || c === "*" || c === "?"))) expandable = true;
      value += c; i += 1;
    }
    return any ? { value, expandable, quoted } : null;
  };

  /** After an operator: skip blanks and read the target word. */
  const readTarget = (): Word | null => {
    while (i < n && (input[i] === " " || input[i] === "\t")) i += 1;
    if (i >= n || controlChars.includes(input[i]!) || input[i] === ">" || input[i] === "<" || isSpace(input[i])) return null;
    return readWord();
  };

  const classifyTarget = (target: Word | null, fd: string, append: boolean, opText: string): RedirectEffect => {
    if (!target || target.value === "") return { kind: "unresolved", text: opText, reason: "redirection without a target", dialect };
    const t = target.value;
    if (dialect === "cmd" && CMD_DEVICES.test(t)) return { kind: "device", target: t, fd, dialect };
    if (dialect === "posix" && POSIX_DEVICES.test(t)) return { kind: "device", target: t, fd, dialect };
    if (dialect === "powershell" && /^\$null$/i.test(t) && !target.quoted) return { kind: "device", target: t, fd, dialect };
    if (target.expandable) return { kind: "unresolved", text: `${opText}${t}`, reason: "the target is expanded by the shell at run time", dialect };
    return { kind: "file", target: t, fd, append, dialect };
  };

  while (i < n) {
    const c = input[i]!;
    if (isSpace(c)) { i += 1; continue; }
    if (dialect === "posix" && c === "#" && (i === 0 || isSpace(input[i - 1]) || controlChars.includes(input[i - 1]!))) break; // comment
    if (dialect === "powershell" && c === "#" && (i === 0 || isSpace(input[i - 1]))) break;

    // Redirection operators (with an optional descriptor prefix handled below).
    if (c === ">" || c === "<" || (c === "&" && input[i + 1] === ">" && dialect === "posix") || (c === "*" && input[i + 1] === ">" && dialect === "powershell")) {
      let fd = "1";
      if (c === "&") { fd = "both"; i += 1; }
      if (c === "*") { fd = "all"; i += 1; }
      if (input[i] === "<") {
        // Input redirection reads; `<>` (POSIX) opens read-write and creates the file.
        if (dialect === "posix" && input[i + 1] === ">") { i += 2; effects.push(classifyTarget(readTarget(), "0", false, "<>")); continue; }
        const heredoc = dialect === "posix" && input[i + 1] === "<" && input[i + 2] !== "<";
        i += 1; while (input[i] === "<") i += 1; if (input[i] === "-") i += 1; if (input[i] === "&") i += 1;
        const source = readTarget();
        if (heredoc && source) {
          // Skip the here-document body: its text is data, not commands.
          const lineEnd = input.indexOf("\n", i);
          if (lineEnd < 0) { i = n; continue; }
          const bodyLines = input.slice(lineEnd + 1).split("\n");
          let consumed = lineEnd + 1; let closed = false;
          for (const line of bodyLines) { consumed += line.length + 1; if (line.replace(/^\t+/, "").replace(/\r$/, "") === source.value) { closed = true; break; } }
          i = closed ? consumed : n;
        }
        continue;
      }
      i += 1; // past '>'
      let append = false;
      if (input[i] === ">") { append = true; i += 1; }
      else if (dialect === "posix" && input[i] === "|") i += 1;
      if (input[i] === "&") {
        i += 1;
        const target = readTarget();
        if (target && /^\d+$|^-$/.test(target.value)) { effects.push({ kind: "descriptor", fd, to: target.value, dialect }); continue; }
        if (dialect === "posix" && fd === "1") { effects.push(classifyTarget(target, "both", append, ">&")); continue; } // bash: >&file
        effects.push({ kind: "unresolved", text: `>&${target?.value ?? ""}`, reason: `"${dialect}" does not redirect to "&${target?.value ?? ""}"`, dialect });
        continue;
      }
      if (dialect === "posix" && input[i] === "(") { effects.push({ kind: "unresolved", text: ">(…)", reason: "process substitution", dialect }); i += 1; continue; }
      effects.push(classifyTarget(readTarget(), fd, append, append ? ">>" : ">"));
      continue;
    }

    // A descriptor number directly before '>' (2>, 1>>, 3>&1).
    if (/[0-9]/.test(c) && (i === 0 || isSpace(input[i - 1]) || controlChars.includes(input[i - 1]!))) {
      let j = i; while (j < n && /[0-9]/.test(input[j]!)) j += 1;
      const digits = input.slice(i, j);
      if (input[j] === ">" && (dialect !== "cmd" || digits.length === 1)) {
        i = j + 1;
        let append = false;
        if (input[i] === ">") { append = true; i += 1; }
        if (input[i] === "&") {
          i += 1;
          const target = readTarget();
          if (target && /^\d+$|^-$/.test(target.value)) effects.push({ kind: "descriptor", fd: digits, to: target.value, dialect });
          else effects.push({ kind: "unresolved", text: `${digits}>&${target?.value ?? ""}`, reason: "descriptor redirection to a non-descriptor", dialect });
          continue;
        }
        effects.push(classifyTarget(readTarget(), digits, append, `${digits}${append ? ">>" : ">"}`));
        continue;
      }
    }

    if (controlChars.includes(c)) {
      let op = c;
      if ((c === "&" || c === "|") && input[i + 1] === c) op = c + c;
      tokens.push({ type: "control", value: op });
      i += op.length;
      continue;
    }

    if (dialect === "posix" && c === "`") {
      const end = input.indexOf("`", i + 1); if (end < 0) throw new Error("unterminated backtick");
      effects.push(...parseRedirections(input.slice(i + 1, end), "posix", 1));
      tokens.push({ type: "word", word: { value: input.slice(i, end + 1), expandable: true, quoted: false } });
      i = end + 1; continue;
    }

    const word = readWord();
    if (word) tokens.push({ type: "word", word });
    else i += 1;
  }

  // PowerShell cmdlets that write files are not redirection syntax, but they write.
  if (dialect === "powershell") {
    for (const t of tokens) {
      if (t.type === "word" && /^(out-file|set-content|add-content|tee-object|new-item|copy-item|move-item|export-csv|export-clixml)$/i.test(t.word.value)) {
        effects.push({ kind: "unresolved", text: t.word.value, reason: "a file-writing cmdlet; its target is not parsed", dialect });
      }
    }
  }
  return { tokens, effects };
}

/** Inline scripts handed to a nested shell are parsed with that shell's rules. */
function nestedScriptEffects(tokens: Token[], depth: number): RedirectEffect[] {
  const effects: RedirectEffect[] = [];
  const segments: Word[][] = [[]];
  for (const t of tokens) {
    if (t.type === "control") segments.push([]);
    else segments[segments.length - 1]!.push(t.word);
  }
  for (const words of segments) {
    if (words.length === 0) continue;
    const exe = words[0]!.value.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "");
    const args = words.slice(1).map((w) => w.value);
    if (["bash", "sh", "zsh", "dash", "ksh"].includes(exe)) {
      const k = args.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a));
      if (k >= 0 && args[k + 1] !== undefined) effects.push(...parseRedirections(args[k + 1]!, "posix", depth + 1));
    } else if (exe === "cmd") {
      const k = args.findIndex((a) => /^\/[ck]$/i.test(a));
      if (k >= 0) effects.push(...parseRedirections(args.slice(k + 1).join(" "), "cmd", depth + 1));
    } else if (exe === "powershell" || exe === "pwsh") {
      const k = args.findIndex((a) => /^-(c|command)$/i.test(a));
      if (k >= 0) effects.push(...parseRedirections(args.slice(k + 1).join(" "), "powershell", depth + 1));
      else if (args.some((a) => /^-(e|enc|encodedcommand)$/i.test(a))) effects.push({ kind: "unresolved", text: "-EncodedCommand", reason: "an encoded PowerShell script is not parsed", dialect: "powershell" });
    }
  }
  return effects;
}

/**
 * Whether the redirections in `command` need the user's approval: any file
 * write, any target the shell resolves at run time, and any device other than
 * a discarded error stream (kept from the earlier rule). Duplicating a stream
 * (2>&1) needs none — it writes nothing.
 */
export function redirectionsRequireApproval(command: string, dialect: ShellDialect): boolean {
  return parseRedirections(command, dialect).some((e) =>
    e.kind === "file" || e.kind === "unresolved" || (e.kind === "device" && e.fd !== "2"),
  );
}
