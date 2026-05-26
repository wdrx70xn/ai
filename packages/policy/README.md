# @ai-sdk/policy

Policy-as-code authorization for AI SDK tool calls, powered by [Open Policy Agent](https://www.openpolicyagent.org/).

Write your "what can this agent do?" rules in a `.rego` file. Plug them into `generateText` / `streamText` / `ToolLoopAgent` as a `toolApproval` configuration. The SDK enforces them at every tool call, with the same wire format used by built-in approvals (`tool-approval-request` / `tool-approval-response`).

## Why

`toolApproval` in `ai` already supports three outcomes: `approved`, `denied`, and `user-approval` (the human-in-the-loop case). What it does not give you is:

1. A place to author the rules that does not require a code deploy.
2. A way for a composite tool (a `bash` or `httpRequest` tool) to consult the same rules before dispatching a nested action. Without that, an agent that holds both a granular `git` tool and a coarse `bash` tool can launder a denied action through `bash`.

This package solves both. Rules live in `.rego`. Composite tools get a `PolicyChecker` in their `execute` options bag.

## Install

```sh
pnpm add @ai-sdk/policy
# pick one (or both) of the OPA backends:
pnpm add @open-policy-agent/opa-wasm   # in-process WASM evaluation
pnpm add @open-policy-agent/opa         # HTTP client to a running OPA server
```

The OPA backends are optional peer dependencies. The package only loads the one you import.

## How the request lifecycle changes

Without policy:

```
model → tool call → tool.execute → result back to model
```

With policy:

```
model
  → tool call
  → toolApproval evaluates  ──┬──► approved      → tool.execute → result back to model
                              ├──► denied        → tool-approval-response (auto, with reason) → model sees the denial
                              └──► user-approval → tool-approval-request → wait for human
                                                                          → tool-approval-response on resume
                                                                          → tool.execute or denial
```

The policy is consulted **before** every tool dispatch. Auto-deny does not require a human; user-approval pauses the run until a human responds with a `tool-approval-response`. The model sees the denial as a structured result on its next step and can reason about it (for example, "I can't drop that table, let me try something else").

Composite tools add a second enforcement point. Inside their `execute`, they call `policy.check(name, args)` (provided by the SDK in the options bag) before dispatching a nested action:

```
model
  → bash tool call
  → toolApproval evaluates "bash" → approved
  → bash.execute starts
       → policy.check("git", { args: ["push"] })
            → toolApproval evaluates "git"  ──┬──► approved      → bash shells out to git push
                                              ├──► denied        → bash returns an error result, git is never invoked
                                              └──► user-approval → bash surfaces the approval request (see below)
```

The deny here is **deterministic and happens before the side effect**. The `git` rule fires whether the model called `git` directly or routed through `bash`.

## Quick start

```ts
import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { opaPolicy, wasmPolicyClient } from '@ai-sdk/policy/opa';
import { readFile } from 'node:fs/promises';

// 1. Load the compiled policy bundle.
const wasm = await readFile('./policy.wasm');
const client = await wasmPolicyClient({ wasm });

// 2. Build the toolApproval configuration.
const toolApproval = opaPolicy({
  client,
  path: 'agent/call/decision',
});

// 3. Pass it to generateText. Everything else is normal.
const result = await generateText({
  model: anthropic('claude-sonnet-4-5'),
  tools: { git, bash, queryLogs },
  toolApproval,
  prompt: 'find the failing test and push the fix',
});
```

## Writing the Rego policy

The adapter expects the policy to emit a decision object with one of three `decision` values. `reason` is optional and gets surfaced back to the model (for `deny`) or to the human approver (for `requires-approval`).

```rego
package agent.call

# Default to "not-applicable" so unmatched calls fall through to whatever
# behavior toolApproval has configured for them. Use { decision: "deny" } if
# you want to default-deny instead.
default decision := { "decision": "not-applicable" }

# Hard deny: pushes are never allowed automatically.
decision := { "decision": "deny", "reason": "pushes require human review" } {
  input.tool.name == "git"
  input.args.args[0] == "push"
}

# Auto-allow: read-only git operations.
decision := { "decision": "allow" } {
  input.tool.name == "git"
  input.args.args[0] in {"status", "log", "diff", "show"}
}

# Human-in-the-loop: kubectl by oncall during business hours.
decision := { "decision": "requires-approval", "reason": "kubectl by oncall" } {
  input.tool.name == "kubectl"
  input.runtimeContext.role == "sre-oncall"
}
```

The adapter also accepts the legacy boolean shape (`{ "allow": true | false, "reason": "..." }`) so existing rules migrate without rewriting.

### What the adapter passes as `input`

By default, the OPA input shape is:

```jsonc
{
  "tool":      { "name": "git" },
  "args":      { "args": ["push", "origin", "main"] },
  "messages":  [ /* model messages for this generation */ ],
  "runtimeContext": { /* whatever you passed as runtimeContext */ },
  "nested":    false  // true when called from a composite tool's policy.check
}
```

Override the shape with `toInput`:

```ts
opaPolicy({
  client,
  path: 'agent/call/decision',
  toInput: ({ toolCall, runtimeContext }) => ({
    action: toolCall.toolName,
    principal: runtimeContext.role,
    resource: toolCall.input,
  }),
});
```

### Testing the policy

OPA ships its own test framework:

```rego
# policy_test.rego
package agent.call

test_push_denied {
  decision.decision == "deny" with input as {
    "tool": { "name": "git" },
    "args": { "args": ["push", "origin", "main"] }
  }
}

test_status_allowed {
  decision.decision == "allow" with input as {
    "tool": { "name": "git" },
    "args": { "args": ["status"] }
  }
}
```

Run `opa test policy.rego policy_test.rego`. These tests run in CI without involving the SDK at all, which is the main practical reason policy-as-code beats policy-in-application-code.

## Loading the policy

### Option A: WASM (in-process)

Compile the `.rego` to WASM ahead of time:

```sh
opa build -t wasm -e 'agent/call/decision' -o bundle.tar.gz policy.rego
tar -xzf bundle.tar.gz /policy.wasm
```

Load it at startup:

```ts
import { wasmPolicyClient, opaPolicy } from '@ai-sdk/policy/opa';
import { readFile } from 'node:fs/promises';

const wasm = await readFile('./policy.wasm');
const client = await wasmPolicyClient({ wasm });

const toolApproval = opaPolicy({ client, path: 'agent/call/decision' });
```

No network call per decision. Good fit when you ship the policy with the app, or fetch it from object storage at startup. Hot-reloading means rebuilding the WASM and re-instantiating the client.

### Option B: HTTP (running OPA server)

Run OPA somewhere:

```yaml
# docker-compose.yml
services:
  opa:
    image: openpolicyagent/opa:latest
    command: ["run", "--server", "--addr", ":8181", "/policies"]
    ports: ["8181:8181"]
    volumes: ["./policies:/policies"]
```

Point the client at it:

```ts
import { httpPolicyClient, opaPolicy } from '@ai-sdk/policy/opa';

const client = httpPolicyClient({ url: 'http://localhost:8181' });
const toolApproval = opaPolicy({ client, path: 'agent/call/decision' });
```

One HTTP round-trip per decision. Good fit when policies change frequently and you want hot-reload without redeploying the app, or when multiple services share one OPA. Headers can be supplied for Styra DAS / EOPA authentication:

```ts
httpPolicyClient({
  url: 'https://opa.internal',
  headers: { Authorization: `Bearer ${token}` },
});
```

## Transitive enforcement: composite tools

`toolApproval` only fires when the model calls a tool directly. Anywhere your agent has a coarse "dispatcher" tool that can perform many fine-grained actions, the model can bypass the rules by going through the coarse tool. The fix is the same in every case: inside the dispatcher's `execute`, derive a `(name, args)` pair for the nested action and call `policy.check` before performing the side effect.

```ts
const decision = await policy?.check(name, args);
if (decision?.type === 'denied') return denyResult(decision.reason);
if (decision?.type === 'user-approval') return needsHumanResult(name);
// approved or not-applicable: proceed with the side effect.
```

The shape of "derive a `(name, args)` pair" depends on the tool. A few common patterns:

### SQL dispatcher

```ts
const db = tool({
  description: 'Run a SQL statement',
  inputSchema: z.object({ sql: z.string() }),
  execute: async ({ sql }, { policy }) => {
    const verb = sql.trim().split(/\s+/)[0].toLowerCase(); // select | insert | delete | drop
    const decision = await policy?.check(`db.${verb}`, { sql });
    if (decision?.type === 'denied') return { error: decision.reason };
    return await pg.query(sql);
  },
});
```

The Rego policy can now write rules like `input.tool.name == "db.delete"` or `input.tool.name == "db.drop"` and they'll fire whether the model called those granular tools directly or routed a `DROP TABLE` through `db.query`.

### HTTP dispatcher

```ts
const http = tool({
  description: 'Make an HTTP request',
  inputSchema: z.object({
    url: z.string(),
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
    body: z.unknown().optional(),
  }),
  execute: async ({ url, method, body }, { policy }) => {
    const host = new URL(url).host;
    const decision = await policy?.check(`http.${method.toLowerCase()}`, { host, url, body });
    if (decision?.type === 'denied') return { error: decision.reason };
    return await fetch(url, { method, body: JSON.stringify(body) });
  },
});
```

Rules can match by host (`input.args.host == "api.production.internal"`) or by method (`input.tool.name == "http.delete"`).

### MCP proxy

```ts
const mcp = tool({
  description: 'Invoke a tool exposed by an MCP server',
  inputSchema: z.object({ tool: z.string(), args: z.unknown() }),
  execute: async ({ tool: name, args }, { policy }) => {
    const decision = await policy?.check(`mcp.${name}`, args);
    if (decision?.type === 'denied') return { error: decision.reason };
    return await mcpClient.callTool(name, args);
  },
});
```

This is the primary motivating case from the RFC: MCP servers expose their entire tool surface as one bundle, and a single `mcp.invoke` meta-tool turns that into one giant `*`-shaped capability for the agent. The check above narrows it back to whatever your Rego policy says is allowed.

### Browser dispatcher

```ts
const browser = tool({
  description: 'Drive the browser',
  inputSchema: z.object({ action: z.enum(['click', 'type', 'navigate']), target: z.string() }),
  execute: async ({ action, target }, { policy }) => {
    const decision = await policy?.check(`browser.${action}`, { target });
    if (decision?.type === 'denied') return { error: decision.reason };
    return await page[action](target);
  },
});
```

### Shell dispatcher

```ts
const bash = tool({
  description: 'Run a shell command',
  inputSchema: z.object({ cmd: z.string() }),
  execute: async ({ cmd }, { policy }) => {
    const [name, ...args] = cmd.split(/\s+/);
    const decision = await policy?.check(name, { args });
    if (decision?.type === 'denied') return { error: decision.reason };
    return await execFile(name, args);
  },
});
```

### The pattern, abstracted

Every example above is the same five lines:

1. Derive a `(name, args)` pair from the dispatcher's input.
2. `await policy?.check(name, args)`.
3. On `denied`, return a structured error so the model can reason about it.
4. On `user-approval`, return an error directing the model to retry through a granular tool (v1). Full nested-approval surfacing is a follow-up.
5. Otherwise, perform the side effect.

What changes per domain is only step 1 (the parsing) and step 5 (the actual side effect). The SDK provides `policy` in the options bag during normal dispatch; it's optional in the type so hand-constructed `ToolExecutionOptions` in tests do not break.

### The honest limitation

The SDK cannot force a tool author to make the check. A dispatcher written as `execute: async ({ cmd }) => exec(cmd)` bypasses the policy layer entirely. The framework's job is to make the right pattern obvious and one-step; that's what this section documents. For stronger guarantees against an actively adversarial tool author, run untrusted execution in an out-of-band sandbox (Vercel Sandbox, Firecracker, containers).

## Scoping a discovered tool surface

When tools come from somewhere external (MCP discovery, a plugin registry, a remote agent catalog) you do not get to write per-tool rules ahead of time — you don't know which tools the server will expose until runtime. The risk: any tool you forgot to write a rule for is silently allowed.

`wrapMcpTools` closes that gap by making the resulting `toolApproval` configuration **total** over the discovered surface. Any tool the supplied approval does not match falls through to a configurable default:

```ts
import { wrapMcpTools } from '@ai-sdk/policy';
import { opaPolicy, wasmPolicyClient } from '@ai-sdk/policy/opa';

const discovered = await mcpClient.tools();
const client = await wasmPolicyClient({ wasm });

const { tools, toolApproval } = wrapMcpTools(
  discovered,
  opaPolicy({ client, path: 'agent/call/decision' }),
  { default: 'user-approval' }, // anything OPA does not match needs a human
);

await generateText({ model, tools, toolApproval, prompt });
```

Three useful defaults:

- `'user-approval'` (the default) — uncovered tools require a human. Right choice when you trust the discovery source but want a safety net for tools you forgot about.
- `'denied'` — uncovered tools are blocked. Right choice for hard allowlist mode: the OPA policy enumerates what's allowed; everything else is rejected before the model can call it.
- `'approved'` — uncovered tools are allowed. Right choice only when the discovery source is fully trusted (rare; usually the wrong call for MCP).

Despite the name, the helper works on any `Record<string, Tool>`, not just MCP-discovered tools.

## API

### `@ai-sdk/policy`

- `wrapMcpTools(tools, approval, opts?)` — bundle a discovered tool set with a fallback approval policy so the resulting `toolApproval` configuration is total over the discovered surface. `opts.default` controls what happens to tools the supplied approval does not match (`'user-approval'` by default; use `'denied'` for hard allowlist mode).
- `PolicyClient` — interface implemented by the OPA backends. Use directly if you want to plug in a non-OPA engine.
- Type re-exports: `PolicyChecker`, `PolicyDecision` (from `@ai-sdk/provider-utils`); helper type `WrappedMcpTools`.

### `@ai-sdk/policy/opa`

- `wasmPolicyClient({ wasm, data? })` — async; loads a compiled OPA WASM bundle in-process. Optional `data` is passed to `setData` if the bundle exposes it.
- `httpPolicyClient({ url, headers? })` — sync; constructs a client against a running OPA server.
- `opaPolicy({ client, path, toInput? })` — returns a `ToolApprovalConfiguration` you pass to `generateText` / `streamText` / `ToolLoopAgent`.
- `normalizeOpaDecision(result)` — exposed for users who want to call OPA themselves and just need the result normalization.

## Versioning

This package follows the AI SDK's release cadence. `peerDependencies` pins `ai` to the workspace version; the OPA backends are versioned independently.

## License

Apache-2.0.
