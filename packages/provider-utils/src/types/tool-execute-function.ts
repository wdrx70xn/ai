import type { Context } from './context';
import type { ModelMessage } from './model-message';
import type { PolicyChecker } from './policy-checker';
import type { Experimental_Sandbox as Sandbox } from './sandbox';

/**
 * Additional options that are sent into each tool execution.
 */
export interface ToolExecutionOptions<
  CONTEXT extends Context | unknown | never,
> {
  /**
   * The ID of the tool call. You can use it e.g. when sending tool-call related information with stream data.
   */
  toolCallId: string;

  /**
   * Messages that were sent to the language model to initiate the response that contained the tool call.
   * The messages **do not** include the system prompt nor the assistant response that contained the tool call.
   */
  messages: ModelMessage[];

  /**
   * An optional abort signal that indicates that the overall operation should be aborted.
   */
  abortSignal?: AbortSignal;

  /**
   * Tool context as defined by the tool's context schema.
   * The tool context is specific to the tool and is passed to the tool execution.
   *
   * Treat the context object as immutable inside tools.
   * Mutating the context object can lead to race conditions and unexpected results
   * when tools are called in parallel.
   *
   * If you need to mutate the context, analyze the tool calls and results
   * in `prepareStep` and update it there.
   */
  context: CONTEXT;

  /**
   * The sandbox environment that the tool is operating in.
   */
  experimental_sandbox?: Sandbox;

  /**
   * Evaluator for the active `toolApproval` policy.
   *
   * Composite tools (`bash`, `httpRequest`, `browserAction`, etc.) should call
   * `policy.check(name, args)` before dispatching a nested action so that the
   * same approval rules that gate direct model tool calls also gate actions
   * dispatched through a coarser tool. Without this, an agent that holds both
   * a granular tool (e.g. `git`) and a coarse one (e.g. `bash`) can launder a
   * denied action through the coarser tool.
   *
   * Always provided by the SDK during normal dispatch. Optional in the type so
   * that tests and tools that hand-construct `ToolExecutionOptions` are not
   * broken by this addition.
   */
  policy?: PolicyChecker;
}

/**
 * Function that executes the tool and returns either a single result or a stream of results.
 */
export type ToolExecuteFunction<
  INPUT,
  OUTPUT,
  CONTEXT extends Context | unknown | never,
> = (
  input: INPUT,
  options: ToolExecutionOptions<CONTEXT>,
) => AsyncIterable<OUTPUT> | PromiseLike<OUTPUT> | OUTPUT;
