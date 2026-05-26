import { NESTED_TOOL_CALL_PREFIX, tool } from '@ai-sdk/provider-utils';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { buildPolicyChecker } from './build-policy-checker';
import type { ToolApprovalConfiguration } from './tool-approval-configuration';

const gitTool = tool({
  inputSchema: z.object({ args: z.array(z.string()) }),
  execute: async () => 'ok',
});

const tools = { git: gitTool };
type Tools = typeof tools;

const seq = () => {
  let n = 0;
  return () => `id-${++n}`;
};

describe('buildPolicyChecker', () => {
  it('returns not-applicable when no approval config is supplied', async () => {
    const checker = buildPolicyChecker<Tools, unknown>({
      tools,
      toolApproval: undefined,
      messages: [],
      toolsContext: {} as never,
      runtimeContext: undefined,
      generateId: seq(),
    });

    const decision = await checker.check('git', { args: ['status'] });

    expect(decision).toEqual({ type: 'not-applicable' });
  });

  it('returns approved for a per-tool config that approves the args', async () => {
    const toolApproval: ToolApprovalConfiguration<Tools, unknown> = {
      git: ({ args }) =>
        args[0] === 'push'
          ? { type: 'denied', reason: 'pushes require approval' }
          : 'approved',
    };

    const checker = buildPolicyChecker<Tools, unknown>({
      tools,
      toolApproval,
      messages: [],
      toolsContext: {} as never,
      runtimeContext: undefined,
      generateId: seq(),
    });

    const decision = await checker.check('git', { args: ['status'] });

    expect(decision).toEqual({ type: 'approved' });
  });

  it('returns denied with the configured reason', async () => {
    const toolApproval: ToolApprovalConfiguration<Tools, unknown> = {
      git: ({ args }) =>
        args[0] === 'push'
          ? { type: 'denied', reason: 'pushes require approval' }
          : 'approved',
    };

    const checker = buildPolicyChecker<Tools, unknown>({
      tools,
      toolApproval,
      messages: [],
      toolsContext: {} as never,
      runtimeContext: undefined,
      generateId: seq(),
    });

    const decision = await checker.check('git', { args: ['push'] });

    expect(decision).toEqual({
      type: 'denied',
      reason: 'pushes require approval',
    });
  });

  it('returns user-approval for an interactive gate', async () => {
    const toolApproval: ToolApprovalConfiguration<Tools, unknown> = {
      git: () => 'user-approval',
    };

    const checker = buildPolicyChecker<Tools, unknown>({
      tools,
      toolApproval,
      messages: [],
      toolsContext: {} as never,
      runtimeContext: undefined,
      generateId: seq(),
    });

    const decision = await checker.check('git', { args: ['push'] });

    expect(decision).toEqual({ type: 'user-approval' });
  });

  it('dispatches through a generic approval function', async () => {
    const toolApproval: ToolApprovalConfiguration<Tools, unknown> = ({
      toolCall,
    }) => {
      if (
        toolCall.toolName === 'git' &&
        Array.isArray((toolCall.input as { args?: unknown[] }).args) &&
        (toolCall.input as { args: string[] }).args[0] === 'push'
      ) {
        return { type: 'denied', reason: 'generic deny' };
      }
      return 'approved';
    };

    const checker = buildPolicyChecker<Tools, unknown>({
      tools,
      toolApproval,
      messages: [],
      toolsContext: {} as never,
      runtimeContext: undefined,
      generateId: seq(),
    });

    expect(await checker.check('git', { args: ['push'] })).toEqual({
      type: 'denied',
      reason: 'generic deny',
    });
    expect(await checker.check('git', { args: ['status'] })).toEqual({
      type: 'approved',
    });
  });

  it('synthesizes a tool call id prefixed with nested-', async () => {
    let seenCallId: string | undefined;
    const toolApproval: ToolApprovalConfiguration<Tools, unknown> = ({
      toolCall,
    }) => {
      seenCallId = toolCall.toolCallId;
      return 'approved';
    };

    const checker = buildPolicyChecker<Tools, unknown>({
      tools,
      toolApproval,
      messages: [],
      toolsContext: {} as never,
      runtimeContext: undefined,
      generateId: seq(),
    });

    await checker.check('git', { args: ['status'] });

    expect(seenCallId?.startsWith(NESTED_TOOL_CALL_PREFIX)).toBe(true);
  });
});
