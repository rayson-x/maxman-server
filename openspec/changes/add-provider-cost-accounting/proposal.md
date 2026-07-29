# Change: Add provider usage and cost accounting

## Why

Current provider accounting is limited to Volcengine async recovery and cannot measure token usage, per-image or per-task calls across swappable provider interfaces. Product pricing needs durable, queryable variable-cost evidence.

## What Changes

- Add a versioned local pricing-rule table and a provider-operation usage ledger.
- Meter provider business operations by their actual billable unit, including the ¥1/accepted-task `dressing_diffusion` rule.
- Record known versus unknown cost without treating unknown price as zero.
- Add an authenticated internal aggregation endpoint for operations, usage units and cost.

## Impact

- Affected specs: new `provider-cost-accounting` capability.
- Affected code: Prisma schema/migrations, provider composition and adapters, Volcengine task ledger bridge, OSS/weather observability, internal routes and tests.
