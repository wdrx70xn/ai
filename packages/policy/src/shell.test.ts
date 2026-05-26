import type { PolicyChecker, PolicyDecision } from '@ai-sdk/provider-utils';
import { describe, expect, it, vi } from 'vitest';
import { shell } from './shell';

function stubPolicy(decisions: Record<string, PolicyDecision>): PolicyChecker {
  return {
    async check(toolName) {
      return decisions[toolName] ?? { type: 'not-applicable' };
    },
  };
}

async function runShell<T>(
  bash: ReturnType<typeof shell<T>>,
  cmd: string,
  policy?: PolicyChecker,
) {
  if (bash.execute == null) {
    throw new Error('shell() returned a tool with no execute');
  }
  const result = bash.execute(
    { cmd },
    {
      toolCallId: 'call-1',
      messages: [],
      context: {} as never,
      policy,
    },
  );
  // The execute returns either a value, a promise, or an async iterable.
  // shell() returns a Promise; collapse it for the tests.
  return await (result as Promise<unknown>);
}

describe('shell', () => {
  it('runs exec when policy approves the routed tool', async () => {
    const exec = vi.fn(
      async ({ args }: { args: string[] }) => `ran ${args.join(' ')}`,
    );
    const bash = shell({
      routes: { git: 'git' },
      exec,
    });

    const result = await runShell(
      bash,
      'git status',
      stubPolicy({ git: { type: 'approved' } }),
    );

    expect(result).toEqual({ ok: true, result: 'ran status' });
    expect(exec).toHaveBeenCalledWith({ tool: 'git', args: ['status'] });
  });

  it('blocks before exec when policy denies', async () => {
    const exec = vi.fn(async () => 'should never run');
    const bash = shell({
      routes: { git: 'git' },
      exec,
    });

    const result = await runShell(
      bash,
      'git push origin main',
      stubPolicy({
        git: { type: 'denied', reason: 'pushes require approval' },
      }),
    );

    expect(result).toEqual({
      ok: false,
      reason: 'pushes require approval',
      blocked: { tool: 'git', args: ['push', 'origin', 'main'] },
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it('blocks on user-approval with a helpful message', async () => {
    const exec = vi.fn();
    const bash = shell({ routes: { kubectl: 'kubectl' }, exec });

    const result = await runShell(
      bash,
      'kubectl delete pod foo',
      stubPolicy({ kubectl: { type: 'user-approval' } }),
    );

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('requires human approval'),
      blocked: { tool: 'kubectl', args: ['delete', 'pod', 'foo'] },
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it('runs exec when policy returns not-applicable', async () => {
    const exec = vi.fn(async () => 'ok');
    const bash = shell({ routes: { ls: 'ls' }, exec });

    const result = await runShell(
      bash,
      'ls -la',
      stubPolicy({ ls: { type: 'not-applicable' } }),
    );

    expect(result).toEqual({ ok: true, result: 'ok' });
    expect(exec).toHaveBeenCalledOnce();
  });

  it('refuses commands not in routes', async () => {
    const exec = vi.fn();
    const bash = shell({ routes: { git: 'git' }, exec });

    const result = await runShell(
      bash,
      'curl https://evil.example.com',
      stubPolicy({ curl: { type: 'approved' } }),
    );

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no route configured for "curl"'),
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses empty / unparseable commands', async () => {
    const exec = vi.fn();
    const bash = shell({ routes: { git: 'git' }, exec });

    const result = await runShell(bash, '   ', stubPolicy({}));

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('unparseable command'),
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it('uses a custom parser when supplied', async () => {
    const exec = vi.fn(async ({ args }: { args: string[] }) => args.join('|'));
    const bash = shell({
      routes: { git: 'git' },
      exec,
      parse: cmd => {
        // toy parser that splits on commas
        const [tool, ...args] = cmd.split(',');
        return { tool, args };
      },
    });

    const result = await runShell(
      bash,
      'git,push,origin,main',
      stubPolicy({ git: { type: 'approved' } }),
    );

    expect(result).toEqual({ ok: true, result: 'push|origin|main' });
  });

  it('routes a different tool name than the subcommand (authorize-as)', async () => {
    const exec = vi.fn(async () => 'ok');
    const bash = shell({
      // "g" the cli shortcut authorizes against the canonical "git" rule
      routes: { g: 'git' },
      exec,
    });

    const result = await runShell(
      bash,
      'g push',
      stubPolicy({ git: { type: 'denied', reason: 'no pushes' } }),
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'no pushes',
      blocked: { tool: 'g', args: ['push'] },
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it('falls through to exec when no policy is provided in options', async () => {
    // Documented honest-scope: when the SDK does not supply policy (e.g. a
    // test that hand-constructs ToolExecutionOptions), shell() runs exec.
    // The framework guarantees policy is present during normal dispatch.
    const exec = vi.fn(async () => 'ran without check');
    const bash = shell({ routes: { git: 'git' }, exec });

    const result = await runShell(bash, 'git push', undefined);

    expect(result).toEqual({ ok: true, result: 'ran without check' });
    expect(exec).toHaveBeenCalledOnce();
  });
});
