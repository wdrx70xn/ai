export type { PolicyClient } from './policy-client';
export { shadow, type PolicyDecisionEvent } from './shadow';
export { wrapMcpTools, type WrappedMcpTools } from './wrap-mcp-tools';

// Convenience re-exports of the core types from `ai` so users can write
// `import type { PolicyChecker } from '@ai-sdk/policy'`.
export type { PolicyChecker, PolicyDecision } from '@ai-sdk/provider-utils';
