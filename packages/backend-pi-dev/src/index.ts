// Backend (Attractor integration)
export { PiAgentCodergenBackend } from "./backend.js";
export type { PiAgentBackendOptions } from "./backend.js";

// Session
export { Session, SessionState } from "./session.js";
export type {
  SessionConfig,
  SessionEvent,
  SessionEventKind,
  SessionEventListener,
  SessionOptions,
} from "./session.js";

// Provider Profiles
export {
  createAnthropicProfile,
  createOpenAIProfile,
  createGeminiProfile,
} from "./provider-profile.js";
export type {
  ProviderProfile,
  CreateProfileOptions,
  TruncationDefaults,
} from "./provider-profile.js";

// Execution Environment
export { LocalExecutionEnvironment } from "./execution-env.js";
export type {
  ExecutionEnvironment,
  ExecResult,
  DirEntry,
  GrepOptions,
  LocalExecutionEnvironmentOptions,
} from "./execution-env.js";
export {
  createReadOperations,
  createWriteOperations,
  createEditOperations,
  createBashOperations,
  createGrepOperations,
  createFindOperations,
  createLsOperations,
} from "./execution-env.js";

// Tools
export { createApplyPatchTool } from "./tools/apply-patch.js";
export { createSubagentTools } from "./tools/subagent.js";

// Utilities
export { detectLoop } from "./loop-detection.js";
export { filterEnv } from "./env-filter.js";
export type { EnvFilterPolicy } from "./env-filter.js";
export { truncateOutput, truncateLines, truncateToolOutput } from "./truncation.js";
export {
  buildFullSystemPrompt,
  discoverProjectDocs,
  gatherEnvironmentContext,
  formatEnvironmentContext,
} from "./system-prompt.js";
export type { EnvironmentContext, SystemPromptOptions } from "./system-prompt.js";
