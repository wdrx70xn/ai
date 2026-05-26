import type {
  Context,
  IdGenerator,
  InferToolSetContext,
  ModelMessage,
  PolicyChecker,
  PolicyDecision,
  ToolSet,
} from '@ai-sdk/provider-utils';
import { resolveToolApproval } from './resolve-tool-approval';
import type { ToolApprovalConfiguration } from './tool-approval-configuration';
import type { TypedToolCall } from './tool-call';

/**
 * Constructs a {@link PolicyChecker} bound to the current dispatch context.
 *
 * The returned checker evaluates the same `toolApproval` configuration that
 * gates direct model tool calls, but against a tool name and args supplied at
 * runtime by a composite tool's `execute`. This lets a `bash` tool, for
 * example, re-check the `git` policy before shelling out to `git push`.
 */
export function buildPolicyChecker<
  TOOLS extends ToolSet,
  RUNTIME_CONTEXT extends Context | unknown | never,
>({
  tools,
  toolApproval,
  messages,
  toolsContext,
  runtimeContext,
  generateId,
}: {
  tools: TOOLS | undefined;
  toolApproval: ToolApprovalConfiguration<TOOLS, RUNTIME_CONTEXT> | undefined;
  messages: ModelMessage[];
  toolsContext: InferToolSetContext<TOOLS>;
  runtimeContext: RUNTIME_CONTEXT;
  generateId: IdGenerator;
}): PolicyChecker {
  return {
    async check(toolName: string, args: unknown): Promise<PolicyDecision> {
      const syntheticToolCall = {
        type: 'tool-call',
        toolCallId: `nested-${generateId()}`,
        toolName,
        input: args,
        dynamic: true,
      } as TypedToolCall<TOOLS>;

      return await resolveToolApproval({
        tools,
        toolCall: syntheticToolCall,
        toolApproval,
        messages,
        toolsContext,
        runtimeContext,
      });
    },
  };
}
