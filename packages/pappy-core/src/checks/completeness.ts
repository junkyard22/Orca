import type { Issue, PappyInput } from "../types.js";
export type { Issue };

// ---------------------------------------------------------------------------
// Concept map for semantic verification (replaces exact keyword matching)
// ---------------------------------------------------------------------------

// Generic action verbs that are too common to be domain-specific
// These should NOT be used as domain cluster triggers
const GENERIC_ACTION_VERBS = new Set([
  'create', 'creates', 'created', 'creating',
  'write', 'writes', 'writing', 'wrote', 'written',
  'read', 'reads', 'reading', 'loaded',
  'build', 'builds', 'built', 'building',
  'make', 'makes', 'making',
  'run', 'runs', 'running', 'execute', 'executes', 'executing',
  'add', 'adds', 'added', 'adding',
  'update', 'updates', 'updated', 'updating',
  'delete', 'deletes', 'deleted', 'deleting',
  'do', 'does', 'did', 'doing', 'done',
  'get', 'gets', 'getting', 'got',
  'use', 'uses', 'used', 'using',
  'set', 'sets', 'setting',
  'change', 'changes', 'changed', 'changing',
  'remove', 'removes', 'removed', 'removing',
  'generate', 'generates', 'generated', 'generating',
  'implement', 'implements', 'implemented', 'implementing',
]);

// Generic nouns that are too common to be domain-specific
const GENERIC_NOUNS = new Set([
  'file', 'files',
  'name', 'names',
  'version', 'versions',
  'description', 'descriptions',
  'field', 'fields',
  'data', 'item', 'items',
  'thing', 'things',
  'task', 'tasks',
  'work', 'works',
]);

const CONCEPT_SYNONYMS: Record<string, string[]> = {
  // Domain-specific concepts only - no generic action verbs
  'form':        ['form', 'forms', 'input', 'inputs', 'submit', 'button', 'field', 'fields', 'validation', 'validat'],
  'api':         ['api', 'apis', 'endpoint', 'endpoints', 'http', 'rest', 'graphql', 'webhook', 'webhooks'],
  'database':    ['database', 'databases', 'db', 'schema', 'schemas', 'table', 'tables', 'query', 'queries', 'sql'],
  'test':        ['test', 'tests', 'testing', 'spec', 'specs', 'assertion', 'verify', 'check', 'validate', 'jest', 'vitest', 'mocha'],
  'component':   ['component', 'components', 'react', 'vue', 'angular', 'element', 'elements', 'render', 'renders', 'props', 'state'],
  'auth':        ['auth', 'authentication', 'authorization', 'login', 'logout', 'signin', 'signup', 'password', 'token', 'jwt', 'oauth'],
  'function':    ['function', 'functions', 'method', 'methods', 'class', 'classes', 'module', 'modules', 'hook', 'hooks', 'functionality', 'functional'],
  'error':       ['error', 'errors', 'throw', 'throws', 'catch', 'catches', 'try', 'except', 'fail', 'fails', 'exception', 'exceptions'],
  'explain':     ['explain', 'explains', 'explanation', 'describes', 'description', 'summarizes', 'summary', 'overview', 'analysis', 'purpose', 'purposes', 'what', 'does', 'how', 'works', 'contains', 'contain', 'returns', 'return', 'structure', 'structures', 'key points', 'key', 'points', 'example', 'examples', 'basic', 'simple'],
  'analyze':     ['analyze', 'analyzes', 'analysis', 'examine', 'examines', 'review', 'reviews', 'inspect', 'inspects', 'assess', 'assesses'],
  // Deployment / infrastructure status queries
  'deployment':  ['deploy', 'deployed', 'deployment', 'deployments', 'release', 'releases', 'rollout', 'staging', 'production', 'prod', 'environment', 'env', 'pipeline', 'ci', 'cd'],
  'status':      ['status', 'state', 'health', 'running', 'stopped', 'active', 'inactive', 'live', 'down', 'up', 'current', 'version', 'build', 'revision'],
};

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'shall', 'can', 'need',
  'tell', 'me', 'it', 'what', 'how', 'why', 'when', 'where', 'who',
  'this', 'that', 'these', 'those', 'my', 'your', 'its', 'our',
  'file', 'files', // too generic to flag
  'output', 'outputs', // refers to the response itself, not a concept
  'provide', 'provides', 'provided', // structural verbs for goals
  'contains', 'contain', 'includes', 'include', // structural verbs
  'explains', 'explain', 'describes', 'describe', // structural verbs for goals
  // QC framework vocabulary — these describe the verification mechanism, not task content
  'receipt', 'ledger', 'proof', 'proved', 'criterion', 'criteria',
  'acceptance', 'verify', 'verified', 'verification', 'verdict', 'pappy',
]);

const SUMMARY_REQUEST_PATTERNS = [
  /\b(summarize|summary|summarise)\b/i,
  /\b(\d+)\s*(bullet|point|item)s?\b/i,
  /\bbrief(ly)?\b/i,
  /\btl;?dr\b/i,
  /\bin\s+\d+\s+(word|sentence|line|point|bullet)s?\b/i,
  /\bshort(ly)?\b/i,
  /\boverview\b/i,
];

const CONDENSED_FORMAT_TERMS = new Set([
  'aspect',
  'aspects',
  'brief',
  'briefly',
  'bullet',
  'bullets',
  'capture',
  'captures',
  'captured',
  'concise',
  'each',
  'item',
  'items',
  'key',
  'overview',
  'point',
  'points',
  'short',
  'shortly',
  'summaries',
  'summarise',
  'summarised',
  'summarises',
  'summarize',
  'summarized',
  'summarizes',
  'summary',
  'tldr',
]);

// ---------------------------------------------------------------------------
// Helper functions for semantic verification
// ---------------------------------------------------------------------------

/**
 * Stem a word by removing common suffixes
 */
function stemWord(word: string): string {
  const suffixes = ['ing', 'ed', 's', 'er', 'ly'];
  let stemmed = word.toLowerCase();
  
  // Try removing suffixes in order of length (longest first)
  for (const suffix of suffixes) {
    if (stemmed.endsWith(suffix) && stemmed.length > suffix.length + 2) {
      stemmed = stemmed.slice(0, -suffix.length);
      break;
    }
  }
  
  return stemmed;
}

/**
 * Check if a word or its stem appears in the output text
 */
function wordOrStemMatches(outputText: string, word: string): boolean {
  const lowerOutput = outputText.toLowerCase();
  const lowerWord = word.toLowerCase();
  const stem = stemWord(lowerWord);
  
  // Check exact word match
  const exactRegex = new RegExp(`\\b${escapeRegExp(lowerWord)}\\b`, 'i');
  if (exactRegex.test(lowerOutput)) {
    return true;
  }
  
  // Check stem match
  if (stem !== lowerWord) {
    const stemRegex = new RegExp(`\\b${escapeRegExp(stem)}\\w*\\b`, 'i');
    if (stemRegex.test(lowerOutput)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract meaningful terms from text, filtering stop words and applying concept map
 */
function extractMeaningfulTerms(text: string): string[] {
  const words = text.toLowerCase().split(/[\s,.;:()\[\]'"\/\\]+/);
  const terms = new Set<string>();
  
  for (const word of words) {
    const trimmed = word.trim();
    if (trimmed.length < 3) continue;
    if (STOP_WORDS.has(trimmed)) continue;
    terms.add(trimmed);
  }
  
  return Array.from(terms);
}

function requestedCondensedFormat(task: string, goals: string[]): boolean {
  const relevantGoals = goals.filter((goal) =>
    !/^(output|function|response|result|code|answer)\s+(contains?|includes?|returns?|prints?|is\b|can\b|will\b|provides?|shows?|has\b|must\b|should\b)/i.test(goal) &&
    !/^(produce|provide|output|generate)\s+(non-?empty|some|an?)\s+(output|response|result)/i.test(goal)
  );
  const combined = [task, ...relevantGoals].join(' ');
  return SUMMARY_REQUEST_PATTERNS.some((pattern) => pattern.test(combined));
}

function hasStructuredFormat(outputText: string): boolean {
  const bulletPattern = /^[\s]*[-•*]\s+.+/m;
  const numberedPattern = /^[\s]*\d+[.)]\s+.+/m;
  const headerPattern = /^#{1,3}\s+.+/m;
  return bulletPattern.test(outputText)
    || numberedPattern.test(outputText)
    || headerPattern.test(outputText);
}

function isCondensedFormatTerm(term: string): boolean {
  const lower = term.toLowerCase();
  return CONDENSED_FORMAT_TERMS.has(lower) || CONDENSED_FORMAT_TERMS.has(stemWord(lower));
}

/**
 * Check if a concept from the task is covered in the output or diff content
 * A concept is covered if any of its synonyms appear in the output or diffs
 */
function isConceptCovered(
  outputText: string,
  concept: string,
  filesChanged?: PappyInput["filesChanged"],
): boolean {
  const lowerOutput = outputText.toLowerCase();
  const synonyms = CONCEPT_SYNONYMS[concept.toLowerCase()] || [];
  
  // Build search text from output and diff content
  let searchText = lowerOutput;
  if (filesChanged && filesChanged.length > 0) {
    const diffContent = filesChanged.map((f) => f.diff ?? "").join("\n");
    searchText += " " + diffContent.toLowerCase();
  }
  
  // Check if any synonym appears in search text
  for (const synonym of synonyms) {
    if (wordOrStemMatches(searchText, synonym)) {
      return true;
    }
  }
  
  // Also check if the concept itself appears (or its stem)
  if (wordOrStemMatches(searchText, concept)) {
    return true;
  }
  
  return false;
}

/**
 * Check if a term is a generic action verb that should not trigger domain matching
 */
function isGenericActionVerb(term: string): boolean {
  const lower = term.toLowerCase();
  return GENERIC_ACTION_VERBS.has(lower) || GENERIC_ACTION_VERBS.has(stemWord(lower));
}

/**
 * Check if a term is a generic noun that should not trigger domain matching
 */
function isGenericNoun(term: string): boolean {
  const lower = term.toLowerCase();
  return GENERIC_NOUNS.has(lower);
}

/**
 * Extract domain concepts from task text using the concept map.
 *
 * This function filters out generic action verbs (create, write, read, etc.) and
 * generic nouns (file, name, version, etc.) that are too common to be domain-specific.
 * Domain cluster matching only triggers on domain-specific nouns like:
 * - form, api, database, test, component, endpoint, schema, auth, etc.
 *
 * Returns an empty array if the task only contains generic terms, which signals
 * that the domain term check should be skipped entirely.
 */
function extractDomainConcepts(task: string): string[] {
  const concepts: string[] = [];
  const lowerTask = task.toLowerCase();
  
  // Check for each concept in the concept map
  for (const concept of Object.keys(CONCEPT_SYNONYMS)) {
    // Skip if this concept would be triggered only by a generic action verb
    if (isGenericActionVerb(concept)) continue;
    
    if (lowerTask.includes(concept) || lowerTask.includes(stemWord(concept))) {
      concepts.push(concept);
    }
  }
  
  // Also extract from meaningful terms
  const meaningfulTerms = extractMeaningfulTerms(task);
  for (const term of meaningfulTerms) {
    // Skip generic action verbs and nouns - they don't indicate domain specificity
    if (isGenericActionVerb(term)) continue;
    if (isGenericNoun(term)) continue;
    
    // Check if this term maps to a known concept
    for (const concept of Object.keys(CONCEPT_SYNONYMS)) {
      // Skip generic concepts
      if (isGenericActionVerb(concept)) continue;
      
      const conceptStem = stemWord(concept);
      if (term === concept || term === conceptStem || term.includes(concept) || concept.includes(term)) {
        if (!concepts.includes(concept)) {
          concepts.push(concept);
        }
      }
    }
  }
  
  return concepts;
}

/**
 * Check if a task is too generic to warrant domain term checking.
 *
 * Tasks that only contain generic action verbs and common nouns should skip
 * the domain term check to avoid spurious missing-term warnings.
 *
 * Examples of generic tasks:
 * - "create a file called config.json with a name and version"
 * - "write a function to sort an array"
 * - "make a script that prints hello"
 *
 * Examples of NON-generic tasks (have domain-specific nouns):
 * - "create a login form with validation" (form, login, validation are domain-specific)
 * - "build a REST API endpoint" (api, endpoint, rest are domain-specific)
 * - "read the file and explain" (explain is a domain concept for explanation tasks)
 */
function isGenericTask(task: string): boolean {
  const lowerTask = task.toLowerCase();
  const terms = extractMeaningfulTerms(task);
  
  // Filter out generic action verbs and nouns
  const domainSpecificTerms = terms.filter(term =>
    !isGenericActionVerb(term) && !isGenericNoun(term) && !STOP_WORDS.has(term)
  );
  
  // Check if the task contains any domain-specific concepts from our concept map
  const domainConcepts = extractDomainConcepts(task);
  
  // Tasks with domain concepts from our map are NOT generic
  // This includes: form, api, database, test, component, auth, function, error, explain, analyze
  if (domainConcepts.length > 0) {
    return false;
  }
  
  // Check for specific domain keywords that indicate a real domain task
  // These are terms that indicate a specific domain context beyond generic programming
  const domainKeywords = [
    'form', 'api', 'endpoint', 'database', 'schema', 'table',
    'test', 'spec', 'component', 'render', 'auth', 'login', 'token',
    'error', 'exception',
    'http', 'rest', 'graphql', 'query', 'mutation',
    'validation', 'validate', 'submit', 'button',
    'jest', 'vitest', 'mocha', 'assertion',
    'react', 'vue', 'angular', 'element', 'props',
    'password', 'jwt', 'oauth', 'authentication', 'authorization'
  ];
  
  for (const keyword of domainKeywords) {
    if (lowerTask.includes(keyword)) {
      return false;
    }
  }
  
  // Special case: tasks about reading/analyzing/explaining a specific file are NOT generic
  // even if they use generic verbs, because they have a specific target
  if (/\b(read|analyze|examine|review|explain|summarize)\b.*\b\w+\.\w+\b/i.test(lowerTask)) {
    return false;
  }
  
  // If we only have generic terms (like "file", "name", "version", "description", "array", "script"),
  // it's a generic task that should skip domain term checking
  return domainSpecificTerms.length <= 2;
}

// ---------------------------------------------------------------------------
// Original domain keyword extraction (kept for backward compatibility)
// ---------------------------------------------------------------------------

/**
 * Extract domain keywords from the task text for semantic completeness checks.
 * Returns a map of keyword → whether it was found in output.
 *
 * This function skips generic tasks that only contain action verbs and common nouns.
 * Domain keywords are only extracted for tasks with domain-specific nouns.
 */
function extractDomainKeywords(task: string): Array<{ keyword: string; category: string }> {
  const keywords: Array<{ keyword: string; category: string }> = [];
  const lower = task.toLowerCase();

  // Skip keyword extraction for generic tasks
  if (isGenericTask(task)) {
    return keywords;
  }

  // Code/implementation patterns — require domain-specific context
  // "login", "form", "input", "submit", "validation" are UI-specific terms
  // Only trigger form keywords if there's actual form-related context (not just "login" for API auth)
  if (/\b(login|form|input|submit|validat|button|field)\b/.test(lower)) {
    // Only flag if this looks like a UI form task, not just API authentication
    // Form context: mentions form, input, button, field, submit together with login
    // API auth context: mentions login with api, endpoint, auth, token, route
    const hasFormContext = /\b(form|input|button|field|submit)\b/.test(lower);
    const hasApiContext = /\b(api|endpoint|auth|token|route|http|request|response)\b/i.test(lower);
    
    if (/\b(login|form|submit|validat)\b/.test(lower) && !hasApiContext) {
      keywords.push({ keyword: "form", category: "UI component" });
      if (hasFormContext) {
        keywords.push({ keyword: "submit", category: "action" });
        keywords.push({ keyword: "validat", category: "validation" });
      }
    }
  }

  // API/HTTP patterns — avoid common English words like "get", "post", "put", "delete"
  // by requiring them to appear in an HTTP method context or alongside API-specific terms.
  if (
    /\b(api|endpoint|http|graphql|rest|webhook)\b|\b(fetch|axios|xhr|curl)\b|\bHTTP (GET|POST|PUT|DELETE|PATCH)\b|\/api\/|api[_\s-]?key/i.test(
      lower,
    )
  ) {
    keywords.push({ keyword: "api", category: "integration" });
    keywords.push({ keyword: "fetch", category: "data access" });
    keywords.push({ keyword: "response", category: "data handling" });
  }

  // Testing patterns — avoid common English words like "it", "describe"
  if (/\b(test|tests|testing|jest|vitest|mocha|spec\.ts|spec\.js|\.test\.|\.spec\.|expect\.|assert\.|toBe|toEqual|toHaveBeenCalled)\b/.test(lower)) {
    keywords.push({ keyword: "test", category: "testing" });
    keywords.push({ keyword: "expect", category: "assertion" });
  }

  // File/system patterns — require filesystem I/O context, not just "file" as a noun
  // "write a function" or "read the docs" should NOT be flagged as I/O requirements
  // "create a file called X with fields" should NOT be flagged - it's a generic config task
  // "read the file X and tell me what it does" should flag file analysis keywords
  // Only flag when there's explicit file I/O operations mentioned (save, load, store, persist)
  // or when read/write is used in a file manipulation context (not just reading for analysis)
  if (/\b(save|load|store|persist)\b/.test(lower)) {
    // Explicit file I/O operations - always flag
    if (!isGenericTask(task)) {
      keywords.push({ keyword: "file", category: "persistence" });
      keywords.push({ keyword: "read", category: "I/O" });
      keywords.push({ keyword: "write", category: "I/O" });
    }
  } else if (
    /\b(read|write)\b.{0,30}\b(file|disk|path|config|json|yaml|csv|txt|xml)\b/.test(lower) ||
    /\b(file|config|json|yaml|csv|txt|xml).{0,30}\b(read|write|load|save|store|persist)\b/.test(lower)
  ) {
    // Read/write file patterns - check if it's about file manipulation or analysis
    const isAnalysisTask = /\b(read|analyze|examine|review)\b.*\b(tell|explain|describe|show|what|how|purpose|contents?)\b/i.test(lower);
    
    if (isAnalysisTask) {
      // For analysis tasks, use explain/analyze keywords instead of I/O keywords
      // This ensures the output is checked for explanation content
      if (!isGenericTask(task)) {
        keywords.push({ keyword: "explain", category: "analysis" });
        keywords.push({ keyword: "summary", category: "analysis" });
      }
    } else if (!isGenericTask(task)) {
      keywords.push({ keyword: "file", category: "persistence" });
      keywords.push({ keyword: "read", category: "I/O" });
      keywords.push({ keyword: "write", category: "I/O" });
    }
  }

  // Error handling patterns
  if (/\b(error|throw|catch|try|except|fail|handle)\b/.test(lower)) {
    keywords.push({ keyword: "error", category: "error handling" });
    keywords.push({ keyword: "catch", category: "error handling" });
  }

  // Component patterns
  if (/\b(component|react|vue|angular|element|render|props|state)\b/.test(lower)) {
    keywords.push({ keyword: "component", category: "architecture" });
    keywords.push({ keyword: "render", category: "UI" });
  }

  return keywords;
}

/**
 * Check if the output text OR any diff in filesChanged contains evidence of addressing a keyword.
 * Scanning diffs ensures we don't false-positive on agents that write all code to files and
 * produce minimal prose (e.g. "Done, changes applied.").
 *
 * If the keyword is in CONCEPT_SYNONYMS, also check for any of its synonyms.
 */
function hasKeywordEvidence(
  outputText: string,
  keyword: string,
  filesChanged?: PappyInput["filesChanged"],
): boolean {
  // Build search text from output and diff content
  let searchText = outputText;
  if (filesChanged && filesChanged.length > 0) {
    const diffContent = filesChanged.map((f) => f.diff ?? "").join("\n");
    searchText += " " + diffContent;
  }
  
  const lowerSearchText = searchText.toLowerCase();

  // If keyword is in CONCEPT_SYNONYMS, check for any of its synonyms
  if (CONCEPT_SYNONYMS[keyword.toLowerCase()]) {
    const synonyms = CONCEPT_SYNONYMS[keyword.toLowerCase()]!;
    for (const synonym of synonyms) {
      if (wordOrStemMatches(lowerSearchText, synonym)) {
        return true;
      }
    }
    return false;
  }
  
  // Otherwise, check for exact keyword match
  const patterns = [
    new RegExp(`\\b${keyword}\\w*\\b`, "i"),
    new RegExp(`\\w*${keyword}\\b`, "i"),
  ];

  // Check prose output first
  if (patterns.some((p) => p.test(outputText))) return true;

  // Also scan diff content — agents often write everything to files with minimal prose
  if (filesChanged && filesChanged.length > 0) {
    const diffContent = filesChanged.map((f) => f.diff ?? "").join("\n");
    if (diffContent.length > 0 && patterns.some((p) => p.test(diffContent))) return true;
  }

  return false;
}

/**
 * Check if filesChanged contains evidence relevant to the task domain.
 */
function hasFileEvidence(filesChanged: PappyInput["filesChanged"], category: string): boolean {
  if (!filesChanged || filesChanged.length === 0) return false;

  const relevantExtensions: Record<string, string[]> = {
    "UI component": [".tsx", ".jsx", ".vue", ".svelte", ".html", ".css"],
    "testing": [".test.ts", ".test.tsx", ".test.js", ".spec.ts", ".spec.tsx"],
    "integration": [".ts", ".js", ".py", ".go", ".rs"],
    "persistence": [".ts", ".js", ".py", ".sql", ".json"],
    "error handling": [".ts", ".js", ".py", ".go", ".rs"],
    "architecture": [".ts", ".tsx", ".js", ".jsx", ".py"],
  };

  const relevantExts = relevantExtensions[category] ?? [".ts", ".js", ".py"];
  return filesChanged.some((f) =>
    relevantExts.some((ext) => f.path.toLowerCase().endsWith(ext)),
  );
}

// ---------------------------------------------------------------------------
// Main completeness checks
// ---------------------------------------------------------------------------

/**
 * Check if at least one acceptance criterion was proved (from tool results)
 */
function hasProvedAC(input: PappyInput): boolean {
  // Check if any tool event indicates a successful operation
  if (input.toolEvents && input.toolEvents.length > 0) {
    return input.toolEvents.some(e => e.ok === true);
  }
  return false;
}

function hasNonDeliverableOutputSignal(outputText: string): boolean {
  return (
    /\[[^\]]+\s+stopped:\s*(?:no_final_output|max_iterations|loop_detected|parse_failure_loop|error)\]/i.test(outputText) ||
    /\[your complete response to the user here\b/i.test(outputText) ||
    /\b(?:is still in progress|are still in progress)\b/i.test(outputText) ||
    /\bOnce (?:the )?.{0,80}(?:complete|finish|done|available),?\s+I (?:will|can)\b/i.test(outputText) ||
    /\bPlease provide .{0,120}\bso (?:that )?I (?:can|will)\b/i.test(outputText)
  );
}

function taskExplicitlyAllowsFileChanges(input: PappyInput): boolean {
  if ((input.constraints?.requireFiles?.length ?? 0) > 0) return true;

  const combined = [input.task, ...(input.goals ?? [])].join(" ");
  const hasChangeVerb =
    /\b(add|adds|added|adding|build|builds|built|building|create|creates|created|creating|delete|deletes|deleted|deleting|edit|edits|edited|editing|fix|fixes|fixed|fixing|generate|generates|generated|generating|implement|implements|implemented|implementing|make|makes|made|making|modify|modifies|modified|modifying|patch|patches|patched|patching|refactor|refactors|refactored|refactoring|remove|removes|removed|removing|replace|replaces|replaced|replacing|save|saves|saved|saving|update|updates|updated|updating|write|writes|writing|wrote|written)\b/i.test(combined);
  if (!hasChangeVerb) return false;

  return (
    /\b(repo|repository|project|code|file|files|app|component|module|script|feature|bug|test|workflow|config|package|source|implementation)\b/i.test(combined) ||
    /\b[\w./\\-]+\.\w{1,8}\b/i.test(combined)
  );
}

function auditFailureCategories(input: PappyInput): string[] {
  const audit = input.metadata?.audit;
  if (!audit || typeof audit !== "object") return [];
  const failures = (audit as { failures?: unknown }).failures;
  if (!Array.isArray(failures)) return [];
  return failures
    .map((item) => item && typeof item === "object" ? (item as { category?: unknown }).category : undefined)
    .filter((category): category is string => typeof category === "string" && category.length > 0);
}

/**
 * Run completeness checks with semantic verification
 */
export function runCompletenessChecks(input: PappyInput): Omit<Issue, "issueId">[] {
  const issues: Omit<Issue, "issueId">[] = [];
  const outputText = input.outputText ?? "";
  const hasOutput = outputText.trim().length > 0;
  const hasFiles = (input.filesChanged?.length ?? 0) > 0;
  const hasTools = (input.toolEvents?.length ?? 0) > 0;
  const isCondensedRequest = requestedCondensedFormat(input.task, input.goals ?? []);
  const isStructuredOutput = hasStructuredFormat(outputText);
  const hasSuccessfulToolUse = (input.toolEvents ?? []).some((event) => event.ok);

  // ── Loop detection check ─────────────────────────────────────────────────────
  // If agent stopped due to loop detection or parse failures, always surface as MEDIUM+.
  // This ensures such runs can never silently PASS.
  const stoppedBecause = (input as any).metadata?.stoppedBecause as string | undefined;
  if (stoppedBecause === 'loop_detected') {
    issues.push({
      severity: 'MEDIUM',
      code: 'AGENT_LOOP_DETECTED',
      category: 'Completeness',
      description: 'Agent stopped due to detected tool call loop — output may be incomplete.',
      expected_receipt: 'Agent should complete task within maxIterations without repeating identical calls.',
      evidence: (input as any).metadata?.loopEvidence?.repeatedCall,
      fix_hint: 'Review the task specification — the agent may have been given insufficient context to complete the task.',
      message: 'Agent stopped due to detected tool call loop — output may be incomplete.',
      suggestedFix: 'Review the task specification — the agent may have been given insufficient context to complete the task.'
    });
  }

  if (stoppedBecause === 'parse_failure_loop') {
    issues.push({
      severity: 'HIGH',
      code: 'AGENT_LOOP_DETECTED',
      category: 'Completeness',
      description: 'Agent stopped after repeated malformed tool call blocks — the model failed to follow the tool-call format.',
      expected_receipt: 'Tool calls must be valid JSON inside <tool_call>…</tool_call> tags.',
      evidence: (input as any).metadata?.loopEvidence?.repeatedCall ?? 'malformed <tool_call> block',
      fix_hint: 'Check model output format handling and ensure the system prompt is clear about the required tool-call JSON format.',
      message: 'Agent stopped after repeated malformed tool call blocks.',
      suggestedFix: 'Ensure the model receives a clear tool-call format instruction and retry.'
    });
  }

  const ahpNonCompleteChildren = input.metadata?.ahpNonCompleteChildren ?? [];
  if (ahpNonCompleteChildren.length > 0) {
    issues.push({
      severity: "HIGH",
      code: "AHP_CHILD_INCONCLUSIVE",
      category: "Completeness",
      description: "One or more AHP child packets did not reach a passing complete state, so the decomposed task cannot be treated as successfully delivered.",
      expected_receipt: "Every required worker child packet must reach COMPLETE with a PASS verdict before the run can pass.",
      evidence: ahpNonCompleteChildren
        .map((child) => `${child.role ?? "child"}:${child.lifecycle ?? "unknown"}:${child.verdict ?? "no-verdict"}:${child.id ?? "unknown"}`)
        .join("; "),
      fix_hint: "Repair or rerun non-passing worker branches and synthesize only after all required child packets pass.",
      message: "AHP child packet did not pass.",
      suggestedFix: "Ensure all decomposed workers produce verified final outputs before QC can pass.",
    });
  }

  if (hasFiles && !taskExplicitlyAllowsFileChanges(input)) {
    issues.push({
      severity: "HIGH",
      code: "UNREQUESTED_FILE_CHANGE",
      category: "Completeness",
      description: "The run changed files even though the task only requested inspection or a returned answer.",
      expected_receipt: "Read-only tasks must not produce filesChanged entries or successful write_file/create_file/modify_file/delete_file events.",
      evidence: `filesChanged=${(input.filesChanged ?? []).map((file) => file.path).join(", ")}`,
      fix_hint: "Do not call file-writing tools unless the user explicitly asks to create, edit, save, or update a file.",
      message: "Run made an unrequested file change.",
      suggestedFix: "Return the requested answer without writing files for read-only inspection tasks.",
    });
  }

  const auditFailures = auditFailureCategories(input);
  const blockingAuditFailures = auditFailures.filter((category) =>
    ["missing_path", "unreadable_path", "bad_workdir", "permission_denied"].includes(category)
  );
  if (blockingAuditFailures.length > 0) {
    issues.push({
      severity: "HIGH",
      code: "AUDIT_PREFLIGHT_FAILED",
      category: "Completeness",
      description: "Project audit preflight failed, so readiness cannot be treated as verified.",
      expected_receipt: "Audit preflight must confirm an existing, readable project directory before scoring readiness.",
      evidence: `audit_failures=${blockingAuditFailures.join(", ")}`,
      fix_hint: "Rerun the audit with an existing readable project directory.",
      message: "Audit preflight failed.",
      suggestedFix: "Provide a valid project path and rerun the audit.",
    });
  } else if (auditFailures.includes("insufficient_evidence") || auditFailures.includes("unsupported_stack")) {
    issues.push({
      severity: "LOW",
      code: "AUDIT_INSUFFICIENT_EVIDENCE",
      category: "Completeness",
      description: "Project audit completed but evidence was incomplete or stack classification was weak.",
      expected_receipt: "Audit output should clearly state incomplete evidence and avoid unsupported readiness claims.",
      evidence: `audit_failures=${auditFailures.join(", ")}`,
      fix_hint: "Keep the response qualified, or add project markers, build/test scripts, docs, and CI evidence.",
      message: "Audit evidence is incomplete.",
      suggestedFix: "Avoid broad readiness claims until more evidence is available.",
    });
  }

  // ── required files from constraints ──────────────────────────────────────
  const requiredFiles = input.constraints?.requireFiles ?? [];
  const touched = new Set((input.filesChanged ?? []).map((f) => f.path));

  for (const requiredPath of requiredFiles) {
    if (!touched.has(requiredPath)) {
      issues.push({
        severity: "HIGH",
        code: "COMPLETENESS_MISSING_FILE",
        category: "Completeness",
        description: `Required file "${requiredPath}" was not changed or created.`,
        expected_receipt: `file_exists or diff showing changes to "${requiredPath}"`,
        evidence: "No entry for this path in filesChanged.",
        fix_hint: `Create or modify "${requiredPath}" and include it in the changeset.`,
        message: `Required file "${requiredPath}" was not present in filesChanged.`,
        suggestedFix: `Ensure "${requiredPath}" is created or modified as part of this task.`,
      });
    }
  }

  // ── Routing-criteria mismatch check ──────────────────────────────────────
  // If the router's done_criteria describe a failure/limitation outcome (e.g.
  // "Output explains inability to access the filesystem") BUT the agent's tool
  // events all succeeded — the router invented a bad rubric that contradicts
  // what actually happened. Flag this as HIGH so it surfaces clearly.
  const LIMITATION_CRITERIA_TERMS = /\b(inability|unable|cannot|can't|can not|could not|couldn't|fail(ed|ure)?|no.access|not.possible|not.support|unavailable|limitation|constraint|denied|reject(ed)?|prohibit|cannot.be|not.be.able|out.of.scope)\b/i;
  const allToolsSucceeded = hasTools && (input.toolEvents ?? []).every((e) => e.ok === true);
  const limitationCriteria = (input.goals ?? []).filter((g) => LIMITATION_CRITERIA_TERMS.test(g));
  if (limitationCriteria.length > 0 && allToolsSucceeded) {
    issues.push({
      severity: "HIGH",
      code: "ROUTING_CRITERIA_MISMATCH",
      category: "Completeness",
      description: `Router generated done_criteria describing failure/limitation states, but all tool calls succeeded. The router invented a rubric that does not reflect the actual task.`,
      expected_receipt: "done_criteria must be grounded in what a correct answer to the task looks like — not assumed limitations.",
      evidence: `Limitation criteria: ${limitationCriteria.map((c) => `"${c}"`).join(", ")}. All ${(input.toolEvents ?? []).length} tool event(s) returned ok=true.`,
      fix_hint: "The router's done_criteria must describe what SUCCESS looks like for this task. Remove any criteria that assume inability or failure when the tools are available and working.",
      message: `done_criteria contain limitation language but all tools succeeded — criteria do not match actual task execution.`,
      suggestedFix: "Fix the router prompt to ground done_criteria in expected successful outcomes, not assumed failure states.",
    });
  }

  // ── task goals completeness: warn if no output and no files ──────────────
  if (!hasOutput && !hasFiles && !hasTools) {
    issues.push({
      severity: "HIGH",
      code: "COMPLETENESS_NO_OUTPUT",
      category: "Completeness",
      description: "No output, no file changes, and no tool events were produced.",
      expected_receipt: "At least one of: outputText, filesChanged, or toolEvents must be non-empty.",
      evidence: "outputText is empty, filesChanged is empty, toolEvents is empty.",
      fix_hint: "Re-run the task and capture output/artifacts.",
      message: "Run produced no output of any kind.",
    });
  }

  // ── No final answer despite tool activity ────────────────────────────────
  // The agent ran tools (or files changed) but never produced a FINAL ANSWER.
  // Tool activity alone is not a deliverable — the user expects a response.
  const hasNoFinalSignal = stoppedBecause === 'no_final_output' || hasNonDeliverableOutputSignal(outputText);
  if (hasNoFinalSignal && (hasTools || hasFiles || hasOutput)) {
    issues.push({
      severity: "HIGH",
      code: "COMPLETENESS_NO_FINAL_OUTPUT",
      category: "Completeness",
      description: "Agent completed work but produced no final deliverable for the user.",
      expected_receipt: "Run must end with a FINAL ANSWER that addresses the task.",
      evidence: `stoppedBecause=${stoppedBecause ?? "unknown"} toolEvents=${(input.toolEvents?.length ?? 0)} filesChanged=${(input.filesChanged?.length ?? 0)} outputText=${hasOutput ? outputText.slice(0, 240) : "empty"}.`,
      fix_hint: "The agent must synthesise its tool findings into a FINAL ANSWER before completing the run.",
      message: "Run has no user-facing final answer.",
    });
  }

  // ── 4.1 Task-aware semantic completeness checks ──────────────────────────
  // Compare what was asked against what was delivered using domain concepts.
  // Skip this check for generic tasks that only contain action verbs and common nouns.
  const domainConcepts = extractDomainConcepts(input.task);
  const keywords = extractDomainKeywords(input.task);

  // Skip domain term checking for generic tasks to avoid spurious warnings
  // e.g., "create a file called config.json with a name and version" should not
  // trigger missing domain terms just because it doesn't mention form/submit/validate
  const shouldSkipDomainCheck = isGenericTask(input.task);

  if (!shouldSkipDomainCheck && (domainConcepts.length > 0 || keywords.length > 0) && (hasOutput || hasFiles)) {
    // Check domain concepts using semantic verification
    const missingConcepts = domainConcepts.filter(
      (c) => !isConceptCovered(outputText, c, input.filesChanged),
    );

    // Check domain keywords using keyword matching (for backward compatibility)
    const missingKeywords = keywords.filter(
      (k) => !hasKeywordEvidence(outputText, k.keyword, input.filesChanged),
    );

    // Combine missing items
    const allMissing = [...missingConcepts, ...missingKeywords.map(k => k.keyword)];
    const uniqueMissing = [...new Set(allMissing)];

    // If >50% of domain items are missing, that's a completeness issue
    const totalDomainItems = domainConcepts.length + keywords.length;
    if (totalDomainItems > 0 && uniqueMissing.length > totalDomainItems * 0.5) {
      const missingTerms = uniqueMissing.join(", ");
      const categories = [...new Set(keywords.map((k) => k.category))].join(", ");

      // Determine severity: MEDIUM by default, LOW if output is substantial and tools were used
      let severity: "MEDIUM" | "LOW" = "MEDIUM";
      if (outputText.length > 200 && hasTools && hasProvedAC(input)) {
        severity = "LOW";
      }

      issues.push({
        severity,
        code: "COMPLETENESS_MISSING_DOMAIN_TERMS",
        category: "Completeness",
        description: `Output does not address key domain concepts from the task: ${missingTerms}.`,
        expected_receipt: `Output should discuss or implement: ${categories}.`,
        evidence: `Task mentions: ${domainConcepts.join(", ")}. Output contains none of: ${missingTerms}.`,
        fix_hint: `Revise the output to address the missing concepts: ${missingTerms}.`,
        message: `Output is missing domain-relevant content for: ${missingTerms}.`,
        suggestedFix: `Include implementation or discussion of: ${missingTerms}.`,
      });
    }
  }

  // Check if files changed are relevant to the task domain
  if (keywords.length > 0 && hasFiles) {
    const categoriesWithoutEvidence = keywords.filter(
      (k) => !hasFileEvidence(input.filesChanged, k.category),
    );

    // If task implies file work but no relevant files changed
    const fileWorkCategories = ["UI component", "testing", "persistence", "architecture"];
    const hasMissingFileWork = categoriesWithoutEvidence.some((k) =>
      fileWorkCategories.includes(k.category),
    );

    if (hasMissingFileWork && categoriesWithoutEvidence.length === keywords.length) {
      issues.push({
        severity: "LOW",
        code: "COMPLETENESS_FILE_MISMATCH",
        category: "Completeness",
        description: "Files changed do not match the task's domain requirements.",
        expected_receipt: "Files with extensions relevant to the task domain.",
        evidence: `Task implies work in: ${keywords.map((k) => k.category).join(", ")}. Changed files may not be relevant.`,
        fix_hint: "Ensure file changes are relevant to the task domain.",
        message: "Changed files may not address the task requirements.",
        suggestedFix: "Modify or create files that are relevant to the task domain.",
      });
    }
  }

  // ── Goal term coverage — verify the output addresses what Brain specified ─
  // QC framework vocabulary — terms that describe the verification mechanism,
  // not the task content. Goals containing these words are infrastructure goals
  // generated by Brain to describe HOW to check the output, not WHAT the output
  // should contain. Keyword-matching them against the output creates false positives.
  //
  // Examples that should be filtered:
  //   "Receipt ledger includes proof of acceptance criteria completion"
  //   "Run trace contains at least one proved criterion"
  //   "Ledger shows all goals met"
  const QC_FRAMEWORK_TERMS = /\b(receipt|ledger|proof|proved|criterion|criteria|acceptance|verif(y|ied|ication)|run.?trace|pappy|qc.?result|verdict)\b/i;
  // Brain's done_criteria flow in as input.goals[]. When goals are meaningful
  // (not just the default "produce output" fallback), check that key terms from
  // the goals are conceptually addressed in the output.
  const meaningfulGoals = (input.goals ?? []).filter((g) =>
    g.length > 10 &&
    // Skip fallback "produce non-empty output" goals
    !/^(produce|provide|output|generate) (non-?empty|some|an?) (output|response|result)/i.test(g) &&
    // Skip Brain's acceptance-criteria descriptions — they describe requirements ABOUT the output
    // ("Output contains X", "Function is syntactically correct") rather than the task topic.
    // These are already checked via the AC receipt ledger; keyword-matching them here creates false positives.
    // "Function can be executed without errors", "Code is syntactically correct", etc.
    !/^(output|function|response|result|code|answer)\s+(contains?|includes?|returns?|prints?|is\b|can\b|will\b|provides?|shows?|has\b|must\b|should\b)/i.test(g) &&
    // Skip repair-pass meta-constraints ("No unrelated behavior changes", "No additional side effects").
    // These are scoping rules, not output content requirements — keyword-matching them creates false positives.
    !/^no\s+(unrelated|unnecessary|additional|extra|breaking|unwanted|other|extraneous)\b/i.test(g) &&
    // Skip criteria that reference the original task / existing behavior — meta-scope constraints.
    !/\b(original\s+task|original\s+behav|existing\s+behav|existing\s+function)\b/i.test(g) &&
    // Skip "Response must/should/is" patterns not already covered above.
    !/^response\s+(is\b|must\b|should\b|will\b|includes?\b|contains?\b|provides?\b)/i.test(g) &&
    // Skip data-quality / accuracy meta-claims: "Counts are based on actual...", "Results are correct", etc.
    // These are verification claims about HOW the answer was derived, not missing content to include.
    !/^(counts?|results?|data|values?|numbers?|information|output)\s+(are|is)\s+(accurate|correct|based|derived|verified|from|on|provided)\b/i.test(g) &&
    // Skip "Output clearly/correctly/accurately distinguishes/separates/shows X" patterns
    !/^(output|response)\s+(clearly|correctly|accurately|explicitly|properly)\s+\w+/i.test(g) &&
    // Skip goals that describe the QC/verification framework itself — "receipt ledger", 
    // "proof of acceptance criteria", etc. These are verification meta-goals, not content goals.
    // The AC receipt ledger already checks these; keyword-matching them creates false positives
    // like flagging a hello world response for not containing the word "ledger".
    !QC_FRAMEWORK_TERMS.test(g)
  );

  if (meaningfulGoals.length > 0 && (hasOutput || hasFiles || hasTools)) {
    // Extract meaningful terms from all goals
    const goalTerms = [...new Set(
      meaningfulGoals
        .flatMap((g) => g.toLowerCase().split(/[\s,.;:()\[\]'"\/\\]+/))
        .filter((t) => t.length > 3 && !STOP_WORDS.has(t))
    )].filter((term) => !(isCondensedRequest && isStructuredOutput && isCondensedFormatTerm(term)));

    if (goalTerms.length >= 2) {
      const diffText = (input.filesChanged ?? []).map((f) => f.diff ?? "").join("\n");
      const searchText = `${outputText.toLowerCase()} ${diffText.toLowerCase()}`;

      // For each goal term, check if it's conceptually covered
      const uncovered: string[] = [];
      const uncoveredConcepts: string[] = [];

      for (const term of goalTerms) {
        // Check if term is in concept map (either as a key or as a synonym value)
        let covered = false;
        
        // First, check if the term itself is a concept key
        for (const [concept, synonyms] of Object.entries(CONCEPT_SYNONYMS)) {
          if (term === concept || term === stemWord(concept)) {
            // Check if any synonym covers this concept
            for (const synonym of synonyms) {
              if (wordOrStemMatches(searchText, synonym)) {
                covered = true;
                break;
              }
            }
            if (covered) break;
          }
          
          // Also check if the term is a synonym value in this concept's list
          // If so, check if any other synonym (or the concept key) is in the output
          if (synonyms.includes(term) || synonyms.some(s => s === stemWord(term))) {
            // Check if the concept key or any other synonym is in the output
            if (wordOrStemMatches(searchText, concept)) {
              covered = true;
              break;
            }
            for (const synonym of synonyms) {
              if (wordOrStemMatches(searchText, synonym)) {
                covered = true;
                break;
              }
            }
            if (covered) break;
          }
        }

        // If not covered by concept map, check exact/stem match
        if (!covered && !wordOrStemMatches(searchText, term)) {
          uncovered.push(term);
          uncoveredConcepts.push(term);
        }
      }

      const coverage = (goalTerms.length - uncovered.length) / goalTerms.length;
      const effectiveThreshold = (
        (isCondensedRequest && isStructuredOutput) ||
        (isStructuredOutput && hasSuccessfulToolUse)
      ) ? 0.35 : 0.60;

      if (coverage < effectiveThreshold) {
        let severity: "MEDIUM" | "LOW" = "MEDIUM";
        const shouldDowngrade = (
          (outputText.length > 200 && hasTools && hasProvedAC(input)) ||
          isCondensedRequest
        ) && (hasOutput || hasFiles);

        if (shouldDowngrade) {
          severity = "LOW";
        }

        issues.push({
          severity,
          code: "COMPLETENESS_GOAL_COVERAGE",
          category: "Completeness",
          description: `Output covers only ${Math.round(coverage * 100)}% of the task goals. Missing concepts: ${uncovered.slice(0, 6).join(", ")}.`,
          expected_receipt: "Output should address all terms from the done_criteria goals.",
          evidence: `Goals: [${meaningfulGoals.map((g) => g.slice(0, 60)).join(" | ")}]. Uncovered concepts: ${uncoveredConcepts.join(", ")}.`,
          fix_hint: `Revise the output to address the missing goal concepts: ${uncovered.slice(0, 6).join(", ")}.`,
          message: `Output does not adequately cover the task goals (${Math.round(coverage * 100)}% coverage).`,
          suggestedFix: `Include content that addresses: ${uncovered.slice(0, 6).join(", ")}.`,
        });
      }
    }
  }

  // ── 4.2 File change verification — verify diffs contain actual content ───
  // Check that file changes contain meaningful diff content, not just metadata.
  for (const file of input.filesChanged ?? []) {
    if (file.changeType === "M" || file.changeType === "A") {
      // Modified or added files should have diff content
      if (!file.diff || file.diff.trim().length === 0) {
        issues.push({
          severity: "MEDIUM",
          code: "COMPLETENESS_EMPTY_DIFF",
          category: "Completeness",
          description: `File "${file.path}" was ${file.changeType === "A" ? "created" : "modified"} but no diff content was provided.`,
          expected_receipt: `diff showing actual content changes in "${file.path}"`,
          evidence: `filesChanged entry for "${file.path}" has no diff or empty diff.`,
          fix_hint: `Include the actual diff/content for "${file.path}" in the file change.`,
          message: `File "${file.path}" has no diff content to verify.`,
          suggestedFix: `Provide the actual content changes for "${file.path}".`,
        });
      } else if (file.diff && file.diff.length < 20) {
        // Suspiciously short diff might indicate placeholder content
        issues.push({
          severity: "LOW",
          code: "COMPLETENESS_SUSPICIOUS_DIFF",
          category: "Completeness",
          description: `File "${file.path}" has a very short diff (${file.diff.length} chars) — may be incomplete.`,
          expected_receipt: `diff with meaningful content for "${file.path}"`,
          evidence: `diff for "${file.path}" is only ${file.diff.length} characters.`,
          fix_hint: `Ensure the diff contains the actual implementation.`,
          message: `Diff for "${file.path}" may be incomplete or placeholder.`,
          suggestedFix: `Include complete implementation in the diff.`,
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Satisfaction checks — does the output actually deliver what was asked?
// ---------------------------------------------------------------------------

/**
 * Detect the primary deliverable the task is requesting.
 * Returns one of: "code" | "fix" | "list" | "explanation" | null
 */
function detectDeliverable(
  task: string,
): { kind: "code" | "fix" | "list" | "explanation"; artifact: string } | null {
  const lower = task.toLowerCase();

  // Code deliverable — explicit verb + code artifact noun
  const codeVerb   = /\b(write|implement|create|build|make|add|code|generate|define)\b/;
  const codeNoun   = /\b(function|method|class|hook|component|algorithm|handler|helper|utility|script|module|interface|type|enum|struct|api|endpoint|middleware|route|service|controller|reducer|action|selector|mixin|decorator|plugin)\b/;
  const codeMatch  = codeNoun.exec(lower);
  if (codeVerb.test(lower) && codeMatch) {
    return { kind: "code", artifact: codeMatch[0] };
  }

  // Fix / debug deliverable
  // NOTE: fix(?!-) excludes compound nouns like "fix-plan", "fix-up" where
  // "fix" is not being used as a transitive verb targeting a code artifact.
  const fixVerbPlusNoun = /\b(fix(?!-)|resolve|debug|correct|patch|repair)\b.{0,50}\b(bug|error|issue|problem|crash|exception|failure|fault|defect)\b/;
  const nounPlusFixVerb = /\b(bug|error|issue|problem|crash|exception)\b.{0,50}\b(fix(?!-)|resolve|debug|correct|patch)\b/;
  if (fixVerbPlusNoun.test(lower) || nounPlusFixVerb.test(lower)) {
    return { kind: "fix", artifact: "bug/error" };
  }

  // List deliverable — task starts with list intent or has explicit list phrase
  if (
    /^(list|enumerate|what are|show all|find all|give me a list)\b/i.test(task.trim()) ||
    /\b(list all|enumerate all|show all|what are (all |the )?(available |possible )?\w+s?)\b/.test(lower)
  ) {
    return { kind: "list", artifact: "items" };
  }

  // Explanation deliverable — caught as a baseline fallback later
  if (/\b(explain|describe|what is|what are|how does|how do|why does|why is|summarize|overview|tell me (about|how))\b/.test(lower)) {
    return { kind: "explanation", artifact: "explanation" };
  }

  return null;
}

/**
 * Run satisfaction checks: does the output actually deliver what the task requested?
 *
 * These complement structural / keyword checks by looking at the deliverable
 * *type* the user intended — code snippet, bug fix, list, explanation — and
 * verifying evidence of that type exists in the output or filesChanged.
 */
export function runSatisfactionChecks(input: PappyInput): Omit<Issue, "issueId">[] {
  const issues: Omit<Issue, "issueId">[] = [];
  const output   = input.outputText ?? "";
  const hasFiles = (input.filesChanged?.length ?? 0) > 0;
  const deliverable = detectDeliverable(input.task);

  if (!deliverable) return issues;

  if (deliverable.kind === "code") {
    // Evidence of code: fenced block, inline code, common code keywords, or a file change
    const hasCodeBlock    = /```/.test(output);
    const hasInlineCode   = /`[^`\n]+`/.test(output);
    const hasCodeKeywords = /\b(def |function |class |const |let |var |export |import |public |private |protected |async |fn |func |procedure )/.test(output);
    const hasCode = hasCodeBlock || hasInlineCode || hasCodeKeywords || hasFiles;

    if (!hasCode) {
      issues.push({
        severity: "HIGH",
        code: "SATISFACTION_CODE_MISSING",
        category: "Completeness",
        description: `Task requests a ${deliverable.artifact} but the output contains no code.`,
        expected_receipt: "Output must contain a code block (```) or a function/class definition, OR filesChanged must be non-empty.",
        evidence: `Task: "${input.task.slice(0, 100)}". No code block, inline code, code keywords, or file changes found.`,
        fix_hint: `Include the requested ${deliverable.artifact} implementation in a fenced code block.`,
        message: `No code was delivered for a task that requests a ${deliverable.artifact}.`,
        suggestedFix: "Provide the implementation in a fenced code block.",
      });
    }
  }

  if (deliverable.kind === "fix") {
    // Evidence of a fix: code in output, file changes, or resolution language
    const hasFixEvidence =
      /```/.test(output) ||
      hasFiles ||
      /\b(fixed?|resolved?|patched?|updated?|changed?|corrected?|removed?)\b/i.test(output);

    if (!hasFixEvidence) {
      issues.push({
        severity: "HIGH",
        code: "SATISFACTION_FIX_MISSING",
        category: "Completeness",
        description: "Task requests a fix/debug but the output contains no fix evidence.",
        expected_receipt: "Output must contain a corrected code block, OR filesChanged must include the fixed file.",
        evidence: `Task: "${input.task.slice(0, 100)}". No code change, file change, or fix language detected.`,
        fix_hint: "Show the specific change that resolves the problem in a code block.",
        message: "No fix was delivered for a fix/debug task.",
        suggestedFix: "Provide the corrected code or an explicit description of the change applied.",
      });
    }
  }

  if (deliverable.kind === "list") {
    // Evidence of a list: bullet/numbered list items in output
    const hasList =
      /^[ \t]*[-*•]\s+/m.test(output) ||
      /^[ \t]*\d+[.)\s]/.test(output) ||
      hasFiles;

    if (!hasList) {
      issues.push({
        severity: "MEDIUM",
        code: "SATISFACTION_LIST_MISSING",
        category: "Completeness",
        description: "Task requests a list but the output contains no list formatting.",
        expected_receipt: "Output must contain a bulleted or numbered list.",
        evidence: `Task: "${input.task.slice(0, 100)}". No list markers (-, *, 1.) found in output.`,
        fix_hint: "Format the items as a bullet or numbered list.",
        message: "No list structure found for a list task.",
        suggestedFix: "Format the response items as a bulleted or numbered list.",
      });
    }
  }

  if (deliverable.kind === "explanation") {
    // An explanation should have at least a minimal substantive response
    const substantive = output.trim().length >= 80;
    if (!substantive && !hasFiles) {
      issues.push({
        severity: "MEDIUM",
        code: "SATISFACTION_EXPLANATION_THIN",
        category: "Completeness",
        description: "Task requests an explanation but the output is too brief to be substantive.",
        expected_receipt: "Output must contain at least 100 characters of explanatory text.",
        evidence: `Task: "${input.task.slice(0, 100)}". Output is only ${output.trim().length} chars.`,
        fix_hint: "Expand the response to fully address the explanation requested.",
        message: "Explanation response is too brief.",
        suggestedFix: "Provide a more detailed explanation.",
      });
    }
  }

  return issues;
}
