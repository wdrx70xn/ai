/**
 * Prefix used on the synthetic `toolCallId` that the SDK assigns to a
 * {@link PolicyChecker.check} invocation from inside a composite tool's
 * `execute`. Engines that want to distinguish direct model tool calls from
 * nested ones (e.g. to record provenance in audit logs) can match this
 * prefix on `toolCall.toolCallId`.
 */
export const NESTED_TOOL_CALL_PREFIX = 'nested-';

/**
 * The decision returned by a {@link PolicyChecker} for a nested tool call.
 *
 * Structurally compatible with the narrowed object form of `ToolApprovalStatus`
 * in the `ai` package. Composite tools branch on `type` and read `reason` for
 * `denied`.
 */
export type PolicyDecision =
  | { type: 'not-applicable'; reason?: never }
  | { type: 'approved'; reason?: string }
  | { type: 'denied'; reason?: string }
  | { type: 'user-approval'; reason?: never };

/**
 * Evaluates the active `toolApproval` policy for a nested tool call.
 *
 * The SDK passes a `PolicyChecker` into every tool's `execute` options bag so
 * that composite tools (`bash`, `httpRequest`, `browserAction`, etc.) can
 * re-check policy for an action they are about to dispatch instead of
 * bypassing it.
 *
 * The returned decision is the same status the active `toolApproval` config
 * would have returned if the model had called the named tool directly with
 * these args.
 */
export interface PolicyChecker {
  check(toolName: string, args: unknown): Promise<PolicyDecision>;
}
