## Context

Provider replacement is an intended BetterMeet seam. Cost must therefore attach to a provider business operation, not to one HTTP library or a workflow caller. Volcengine async APIs need a special bridge because a successfully accepted task is billable before polling finishes.

## Decisions

- A normalized provider-operation ledger records provider, operation, model, status, measured units, rule identity and nullable estimated cost.
- Local rules are versioned and bind to the operation at write time; later price edits never rewrite historical estimates.
- A metering wrapper at the existing provider-operation contracts is the normal seam. The Volcengine task ledger emits the accepted-task measurement at submit time.
- Unknown price preserves units and a null cost. Free is an explicit zero-price rule.
- Aggregation is internal-only, separates known cost from unknown usage, and does not create payment or quota behaviour.

## Risks

- Direct client uploads and provider-side image fetching cannot always expose OSS traffic. Record only measurable server-side OSS operations; do not infer missing values.
- Provider SDK usage shapes vary. Preserve a redacted source summary and leave unsupported units absent rather than estimating them.
