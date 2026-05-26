import { jsonSchema, tool } from '@ai-sdk/provider-utils';

/**
 * Parsed shell invocation. `tool` is the registered tool name whose
 * `toolApproval` rule will gate the call; `args` is the remaining argv.
 */
export interface ParsedShellInvocation {
  tool: string;
  args: string[];
}

/**
 * Result envelope returned by {@link shell}.
 *
 * `ok: true` carries whatever the `exec` function returned. `ok: false`
 * carries a structured deny so the model can reason about the rejection
 * on its next step.
 */
export type ShellResult<T> =
  | { ok: true; result: T }
  | {
      ok: false;
      reason: string;
      blocked?: { tool: string; args: string[] };
    };

/**
 * Build a composite "shell" tool that re-checks the active `toolApproval`
 * policy before dispatching a subcommand.
 *
 * `routes` maps the first token of the shell command to the registered tool
 * name to authorize against. When the model calls `shell({ cmd: "git push" })`,
 * the wrapper looks up `git` in `routes`, finds the authorize-as name, calls
 * `policy.check(name, { args })`, and only invokes `exec` when the decision
 * is `approved` / `not-applicable`.
 *
 * Denies short-circuit before `exec` runs. `user-approval` is surfaced as a
 * structured error in v1 (the model can retry with a different approach);
 * full nested-approval surfacing is a follow-up.
 *
 * @example
 * ```ts
 * import { shell } from '@ai-sdk/policy';
 * import { execFile } from 'node:child_process';
 * import { promisify } from 'node:util';
 *
 * const run = promisify(execFile);
 *
 * const bash = shell({
 *   routes: { git: 'git', kubectl: 'kubectl' },
 *   exec: async ({ tool: t, args }) => {
 *     const { stdout } = await run(t, args);
 *     return stdout;
 *   },
 * });
 * ```
 */
export function shell<T = string>(opts: {
  description?: string;
  routes: Record<string, string>;
  exec: (invocation: ParsedShellInvocation) => Promise<T>;
  parse?: (cmd: string) => ParsedShellInvocation | null;
}) {
  const parseFn = opts.parse ?? defaultParse;

  return tool({
    description:
      opts.description ??
      'Execute a shell command, gated by the active policy.',
    inputSchema: jsonSchema<{ cmd: string }>({
      type: 'object',
      properties: { cmd: { type: 'string' } },
      required: ['cmd'],
      additionalProperties: false,
    }),
    execute: async ({ cmd }, { policy }): Promise<ShellResult<T>> => {
      const parsed = parseFn(cmd);
      if (parsed == null || parsed.tool === '') {
        return { ok: false, reason: `unparseable command: ${cmd}` };
      }

      const authorizeAs = opts.routes[parsed.tool];
      if (authorizeAs == null) {
        return {
          ok: false,
          reason: `no route configured for "${parsed.tool}"`,
          blocked: parsed,
        };
      }

      const decision = await policy?.check(authorizeAs, { args: parsed.args });

      if (decision?.type === 'denied') {
        return {
          ok: false,
          reason: decision.reason ?? `policy denied "${authorizeAs}"`,
          blocked: parsed,
        };
      }

      if (decision?.type === 'user-approval') {
        return {
          ok: false,
          reason: `"${authorizeAs}" requires human approval; retry through a granular tool that the operator can approve`,
          blocked: parsed,
        };
      }

      const result = await opts.exec(parsed);
      return { ok: true, result };
    },
  });
}

function defaultParse(cmd: string): ParsedShellInvocation | null {
  const trimmed = cmd.trim();
  if (trimmed === '') return null;
  const parts = trimmed.split(/\s+/);
  return { tool: parts[0], args: parts.slice(1) };
}
