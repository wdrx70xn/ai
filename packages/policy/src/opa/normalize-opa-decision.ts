import type { PolicyDecision } from '@ai-sdk/provider-utils';

/**
 * Normalize an OPA evaluation result into the SDK's {@link PolicyDecision}
 * shape.
 *
 * Supports two Rego output conventions:
 *
 * - **Recommended (explicit):** `{ "decision": "allow" | "deny" | "requires-approval", "reason": string }`.
 *   Maps to `approved` / `denied` / `user-approval` respectively.
 *
 * - **Legacy (boolean):** `{ "allow": boolean, "reason"?: string }`. `true`
 *   maps to `approved`, `false` to `denied`.
 *
 * Unknown shapes and `undefined` are treated as `not-applicable` so that a
 * Rego rule that does not match any branch defaults to "no opinion" rather
 * than blocking.
 */
export function normalizeOpaDecision(result: unknown): PolicyDecision {
  if (result == null) {
    return { type: 'not-applicable' };
  }

  if (typeof result !== 'object') {
    return { type: 'not-applicable' };
  }

  const record = result as Record<string, unknown>;

  if (typeof record.decision === 'string') {
    const reason =
      typeof record.reason === 'string' ? record.reason : undefined;
    switch (record.decision) {
      case 'allow':
        return reason ? { type: 'approved', reason } : { type: 'approved' };
      case 'deny':
        return reason ? { type: 'denied', reason } : { type: 'denied' };
      case 'requires-approval':
        return { type: 'user-approval' };
      case 'not-applicable':
        return { type: 'not-applicable' };
    }
  }

  if (typeof record.allow === 'boolean') {
    if (record.allow) {
      const reason =
        typeof record.reason === 'string' ? record.reason : undefined;
      return reason ? { type: 'approved', reason } : { type: 'approved' };
    }
    const reason =
      typeof record.reason === 'string' ? record.reason : undefined;
    return reason ? { type: 'denied', reason } : { type: 'denied' };
  }

  return { type: 'not-applicable' };
}
