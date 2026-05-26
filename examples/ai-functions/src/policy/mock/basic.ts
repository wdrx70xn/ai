/**
 * Policy stack: end-to-end demo against a mock model.
 *
 * Three flows in one file:
 *
 *   1. Direct call to an allowed tool (`searchOrders`) -> executes normally.
 *   2. Direct call to a denied tool (`deleteOrder`) -> `toolApproval` gate
 *      fires, the model sees a structured deny, `execute` is never invoked.
 *   3. Composite-tool dispatch via `runCommand("deleteOrder 42")` -> the
 *      dispatcher consults `options.policy?.check()` before performing the
 *      underlying action and propagates the deny.
 *
 * Uses `MockLanguageModelV3` from `ai/test`, so the example runs offline with
 * no API keys. To drive it against a real provider, swap the `model:` line
 * for the provider of your choice, e.g.:
 *
 *     import { anthropic } from '@ai-sdk/anthropic';
 *     model: anthropic('claude-sonnet-4-5'),
 *
 * Run: `pnpm tsx examples/ai-functions/src/policy/mock/basic.ts`
 */

import {
  generateText,
  stepCountIs,
  tool,
  type ToolApprovalConfiguration,
} from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { run } from '../../lib/run';

const usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

function modelEmitsToolCall(opts: {
  toolCallId: string;
  toolName: string;
  input: string;
}) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      warnings: [],
      finishReason: { raw: undefined, unified: 'tool-calls' },
      usage,
      content: [
        {
          type: 'tool-call',
          toolCallType: 'function',
          toolCallId: opts.toolCallId,
          toolName: opts.toolName,
          input: opts.input,
        },
      ],
    }),
  });
}

// Counters prove that the deny paths short-circuit before the side effect.
let searchOrdersInvocations = 0;
let deleteOrderInvocations = 0;

const searchOrders = tool({
  description: 'Search for orders',
  inputSchema: z.object({ q: z.string() }),
  execute: async ({ q }) => {
    searchOrdersInvocations++;
    return { results: [`order-1 (${q})`, `order-2 (${q})`, `order-3 (${q})`] };
  },
});

const deleteOrder = tool({
  description: 'Delete an order by id',
  inputSchema: z.object({ id: z.number() }),
  execute: async ({ id }) => {
    deleteOrderInvocations++;
    return { deleted: id };
  },
});

const runCommand = tool({
  description: 'Run a shell-style command against the order system',
  inputSchema: z.object({ cmd: z.string() }),
  execute: async ({ cmd }, { policy }) => {
    const [name, idStr] = cmd.trim().split(/\s+/);
    const id = Number(idStr);
    const decision = await policy?.check(name, { id });

    if (decision?.type === 'denied') {
      return { ok: false, blocked: name, reason: decision.reason };
    }
    if (decision?.type === 'user-approval') {
      return { ok: false, blocked: name, reason: 'requires human approval' };
    }
    // approved or not-applicable: pretend we ran the side effect.
    return { ok: true, executed: name, id };
  },
});

const tools = { searchOrders, deleteOrder, runCommand };

const toolApproval: ToolApprovalConfiguration<typeof tools, unknown> = ({
  toolCall,
}) =>
  toolCall.toolName === 'deleteOrder'
    ? { type: 'denied', reason: 'destructive operation' }
    : 'approved';

async function demo(
  label: string,
  toolCallId: string,
  toolName: keyof typeof tools,
  input: object,
) {
  console.log(`\n--- ${label} ---`);
  console.log(`model emits: ${toolName}(${JSON.stringify(input)})`);

  const result = await generateText({
    model: modelEmitsToolCall({
      toolCallId,
      toolName,
      input: JSON.stringify(input),
    }),
    tools,
    toolApproval,
    prompt: label,
    stopWhen: stepCountIs(1),
  });

  console.log(
    `tool calls    :`,
    result.toolCalls.map(c => c.toolName),
  );
  console.log(`tool results  :`, JSON.stringify(result.toolResults, null, 2));
  console.log(
    `invocations   : searchOrders=${searchOrdersInvocations}, deleteOrder=${deleteOrderInvocations}`,
  );
}

run(async () => {
  await demo('1) allowed direct call', 'c1', 'searchOrders', { q: 'pending' });
  await demo('2) denied direct call', 'c2', 'deleteOrder', { id: 42 });
  await demo('3) denied transitive call', 'c3', 'runCommand', {
    cmd: 'deleteOrder 42',
  });

  console.log(
    `\nfinal: deleteOrder.execute was invoked ${deleteOrderInvocations} time(s) (expected: 0)`,
  );
});
