import {
  NESTED_TOOL_CALL_PREFIX,
  type Context,
  type InferToolSetContext,
  type ModelMessage,
  type ToolSet,
} from '@ai-sdk/provider-utils';
import type { ToolApprovalConfiguration } from 'ai';
import type { PolicyClient } from '../policy-client';
import { normalizeOpaDecision } from './normalize-opa-decision';

/**
 * The default shape passed to the OPA rule as `input` when no `toInput` is
 * supplied. Rego rules can read `input.tool.name`, `input.args`, and so on.
 */
export interface DefaultOpaInput {
  tool: { name: string };
  args: unknown;
  messages: ReadonlyArray<ModelMessage>;
  runtimeContext: unknown;
  /** Convenience: `true` when the call originated from a composite tool's
   * `policy.check`, identifiable by the synthetic `nested-` prefix on
   * `toolCallId`. */
  nested: boolean;
}

/**
 * Construct a {@link ToolApprovalConfiguration} backed by an OPA policy.
 *
 * The returned generic approval function evaluates the supplied Rego entry
 * (`path`) for every tool call and maps the result to the SDK's approval
 * status via {@link normalizeOpaDecision}. Pass the result directly as
 * `toolApproval` on `generateText` / `streamText` / `ToolLoopAgent`.
 *
 * ```ts
 * import { wasmPolicyClient } from '@ai-sdk/policy/opa';
 * import { opaPolicy } from '@ai-sdk/policy/opa';
 *
 * const client = await wasmPolicyClient({ wasm });
 * const toolApproval = opaPolicy({ client, path: 'agent/call/decision' });
 *
 * await generateText({ model, tools, toolApproval, prompt });
 * ```
 *
 * @param opts.client    The OPA client (HTTP or WASM).
 * @param opts.path      The Rego entrypoint that returns the decision object.
 * @param opts.toInput   Optional transformer to shape the OPA input.
 */
export function opaPolicy<
  TOOLS extends ToolSet = ToolSet,
  RUNTIME_CONTEXT extends Context | unknown | never = unknown,
>(opts: {
  client: PolicyClient;
  path: string;
  toInput?: (args: {
    toolCall: { toolName: string; toolCallId: string; input: unknown };
    tools: TOOLS | undefined;
    toolsContext: InferToolSetContext<TOOLS>;
    runtimeContext: RUNTIME_CONTEXT;
    messages: ModelMessage[];
  }) => unknown;
}): ToolApprovalConfiguration<TOOLS, RUNTIME_CONTEXT> {
  const { client, path, toInput } = opts;

  return async ({
    toolCall,
    tools,
    toolsContext,
    runtimeContext,
    messages,
  }) => {
    const opaInput =
      toInput?.({ toolCall, tools, toolsContext, runtimeContext, messages }) ??
      ({
        tool: { name: toolCall.toolName },
        args: toolCall.input,
        messages,
        runtimeContext,
        nested: toolCall.toolCallId.startsWith(NESTED_TOOL_CALL_PREFIX),
      } satisfies DefaultOpaInput);

    const result = await client.evaluate(path, opaInput);
    return normalizeOpaDecision(result);
  };
}
