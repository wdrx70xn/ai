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

## Transitive enforcement: a composite `bash` tool

`toolApproval` only fires when the model calls a tool directly. To extend the same rules into a composite tool, read `policy` from the `execute` options bag:

```ts
import { tool } from 'ai';
import * as z from 'zod/v4';

const bash = tool({
  description: 'Run a shell command',
  inputSchema: z.object({ cmd: z.string() }),
  execute: async ({ cmd }, { policy }) => {
    const [name, ...args] = cmd.split(/\s+/);

    // Re-check the same toolApproval config that gates direct calls.
    const decision = await policy?.check(name, { args });

    if (decision?.type === 'denied') {
      return { error: 'blocked by policy', reason: decision.reason };
    }
    if (decision?.type === 'user-approval') {
      // v1: return an error and let the model retry.
      // Surfacing this as an approval-request for the child action is a
      // follow-up (see the RFC's "nested user-approval" section).
      return { error: 'requires human approval', tool: name };
    }

    return await exec(cmd);
  },
});
```

The SDK provides `policy` in the options bag during normal dispatch. It is optional in the type (so hand-constructed `ToolExecutionOptions` in tests do not break), but at runtime it is always present.

### The honest limitation

The SDK cannot force a tool author to call `policy.check`. A hand-rolled `bash` written as `execute: async ({ cmd }) => exec(cmd)` will bypass the policy layer entirely. The framework's job is to make the right pattern the default path; the canonical wrappers (`shell()`, `httpRequest()`, `browserAction()` — coming soon) will implement the check internally so you don't write it yourself. For stronger guarantees, run untrusted code in an out-of-band sandbox (Vercel Sandbox, Firecracker, containers).

## API

### `@ai-sdk/policy`

- `PolicyClient` — interface implemented by the OPA backends. Use directly if you want to plug in a non-OPA engine.
- Type re-exports: `PolicyChecker`, `PolicyDecision` (from `@ai-sdk/provider-utils`).

### `@ai-sdk/policy/opa`

- `wasmPolicyClient({ wasm, data? })` — async; loads a compiled OPA WASM bundle in-process. Optional `data` is passed to `setData` if the bundle exposes it.
- `httpPolicyClient({ url, headers? })` — sync; constructs a client against a running OPA server.
- `opaPolicy({ client, path, toInput? })` — returns a `ToolApprovalConfiguration` you pass to `generateText` / `streamText` / `ToolLoopAgent`.
- `normalizeOpaDecision(result)` — exposed for users who want to call OPA themselves and just need the result normalization.

## Versioning

This package follows the AI SDK's release cadence. `peerDependencies` pins `ai` to the workspace version; the OPA backends are versioned independently.

## License

Apache-2.0.
