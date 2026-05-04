export { createClaire } from "./claire.js";
export type {
  ClaireInstance,
  ClaireDeps,
  ClaireHandleOptions,
  ClaireComplete,
  ClaireMessage,
  ConversationTurn,
  ExecutionResult,
  TaskSpec,
  ExecuteTaskOptions,
} from "./types.js";
export { CLAIRE_SYSTEM_PROMPT, buildClaireMessages, buildPresentPrompt, buildFailurePrompt } from "./voice.js";
