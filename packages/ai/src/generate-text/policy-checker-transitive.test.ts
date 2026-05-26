import { tool } from '@ai-sdk/provider-utils';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import { buildPolicyChecker } from './build-policy-checker';
import type { ToolApprovalConfiguration } from './tool-approval-configuration';

/**
 * The "bash launders a forbidden git push" scenario. We don't drive the full
 * generate-text loop here; we drive the contract directly: build the same
 * PolicyChecker the SDK would pass into execute, and assert that a composite
 * tool consulting it reproduces the deny without ever invoking the underlying
 * sub-tool's execute.
 */
describe('PolicyChecker (transitive enforcement)', () => {
  const gitExecute = vi.fn(async (_: { args: string[] }) => 'ran git');

  const gitTool = tool({
    inputSchema: z.object({ args: z.array(z.string()) }),
    execute: gitExecute,
  });

  const tools = { git: gitTool };
  type Tools = typeof tools;

  const seq = () => {
    let n = 0;
    return () => `id-${++n}`;
  };

  const denyPushes: ToolApprovalConfiguration<Tools, unknown> = {
    git: ({ args }) =>
      args[0] === 'push'
        ? { type: 'denied', reason: 'pushes require approval' }
        : 'approved',
  };

  it('denies a nested git push routed through a bash-style composite tool', async () => {
    const policy = buildPolicyChecker<Tools, unknown>({
      tools,
      toolApproval: denyPushes,
      messages: [],
      toolsContext: {} as never,
      runtimeContext: undefined,
      generateId: seq(),
    });

    // A bash-style composite tool that re-checks policy before dispatching.
    const bashExecute = async (cmd: string) => {
      const parts = cmd.split(/\s+/);
      const [name, ...args] = parts;
      const decision = await policy.check(name, { args });

      if (decision.type === 'denied') {
        return { ok: false as const, reason: decision.reason };
      }
      if (decision.type === 'user-approval') {
        return { ok: false as const, reason: 'requires user approval' };
      }
      // approved or not-applicable
      const result = await gitExecute({ args });
      return { ok: true as const, result };
    };

    const result = await bashExecute('git push origin main');

    expect(result).toEqual({ ok: false, reason: 'pushes require approval' });
    expect(gitExecute).not.toHaveBeenCalled();
  });

  it('lets non-denied nested calls run', async () => {
    gitExecute.mockClear();

    const policy = buildPolicyChecker<Tools, unknown>({
      tools,
      toolApproval: denyPushes,
      messages: [],
      toolsContext: {} as never,
      runtimeContext: undefined,
      generateId: seq(),
    });

    const bashExecute = async (cmd: string) => {
      const parts = cmd.split(/\s+/);
      const [name, ...args] = parts;
      const decision = await policy.check(name, { args });

      if (decision.type === 'denied') {
        return { ok: false as const, reason: decision.reason };
      }
      return { ok: true as const, result: await gitExecute({ args }) };
    };

    const result = await bashExecute('git status');

    expect(result).toEqual({ ok: true, result: 'ran git' });
    expect(gitExecute).toHaveBeenCalledTimes(1);
  });

  it('documented limitation: a composite tool that does NOT call policy.check bypasses the gate', async () => {
    // This test exists to lock the honest-scope statement: the SDK cannot force
    // a tool to honor the contract. A hand-rolled bash that omits the check
    // gets today's behavior. Out-of-band sandboxing is the only true guarantee.
    gitExecute.mockClear();

    const policy = buildPolicyChecker<Tools, unknown>({
      tools,
      toolApproval: denyPushes,
      messages: [],
      toolsContext: {} as never,
      runtimeContext: undefined,
      generateId: seq(),
    });

    // intentionally never reads `policy`
    void policy;

    const naiveBash = async (cmd: string) => {
      const parts = cmd.split(/\s+/);
      const [, ...args] = parts;
      return await gitExecute({ args });
    };

    const result = await naiveBash('git push origin main');

    expect(result).toBe('ran git');
    expect(gitExecute).toHaveBeenCalledTimes(1);
  });
});
