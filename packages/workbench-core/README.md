# Workbench Core

Core runtime foundation for building tool-execution applications.

## Installation

```bash
npm install @yakstacks/workbench-core
```

## What's Included

### Runners
Execute tools in specific environments (shell, Python, Node, etc.)

```typescript
import { ShellRunner, runnerRegistry, ToolSpec } from '@yakstacks/workbench-core';

// Get the shell runner
const runner = runnerRegistry.findRunner(toolSpec);

// Prepare execution plan
const plan = runner.prepare(toolSpec, input);

// Verify results
const outcome = runner.verify(result, toolSpec);
```

### Event Bus
Runtime observability with typed events.

```typescript
import { eventBus, RuntimeEvent } from '@yakstacks/workbench-core';

// Subscribe to tool events
eventBus.on('tool:started', (event) => {
  console.log(`Tool ${event.toolName} started`);
});

// Emit events
eventBus.emit({
  type: 'tool:started',
  toolName: 'my-tool',
  runId: '123',
  timestamp: Date.now()
});
```

### Verification
Structured tool result outcomes.

```typescript
import { wrapToolResult, createVerification } from '@yakstacks/workbench-core';

// Wrap existing results with verification
const verified = wrapToolResult(rawResult, 'tool-name');
// verified.verification.status === 'PASS' | 'FAIL'
```

### Diagnostics
Doctor system for runtime health checks.

```typescript
import { runDiagnostics } from '@yakstacks/workbench-core';

const report = await runDiagnostics();
// report.summary.pass, report.summary.fail, report.summary.warn
```

## API Reference

### Types

```typescript
// Tool specification
interface ToolSpec {
  name: string;
  command?: string;
  script?: string;
  input?: any;
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
}

// Execution plan
interface ExecutionPlan {
  runner: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeout: number;
  shell: boolean;
}

// Execution result
interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
  error?: string;
}

// Verification outcome
interface VerificationOutcome {
  status: 'PASS' | 'FAIL';
  reason?: string;
  suggestion?: string;
}
```

### Exports

| Export | Description |
|--------|-------------|
| `ShellRunner` | Shell-based tool execution runner |
| `RunnerRegistry` | Registry for managing runners |
| `runnerRegistry` | Singleton runner registry instance |
| `EventBus` | Pub/sub event system |
| `eventBus` | Singleton event bus instance |
| `createTimestamp` | Helper to create event timestamps |
| `createVerification` | Create verification from result |
| `wrapToolResult` | Wrap result with verification |
| `isVerifiedResult` | Type guard for verified results |
| `runDiagnostics` | Run doctor diagnostics |

## Building Apps on Workbench Core

Workbench Core provides the foundation. Your app provides:

1. **Tools** - Define what tools are available
2. **UI** - User interface for interaction
3. **Storage** - Persistence for sessions, config
4. **Integration** - Connect to AI models, APIs

Example architecture:

```
Your App (Maestro, etc.)
    │
    ├── UI Layer (React, etc.)
    ├── Tool Definitions
    ├── Storage Layer
    │
    └── @yakstacks/workbench-core
            ├── Runners (execute tools)
            ├── Events (observability)
            ├── Verification (result checking)
            └── Diagnostics (health checks)
```

## License

MIT
