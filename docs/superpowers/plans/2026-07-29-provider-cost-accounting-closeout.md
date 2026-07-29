# Provider Cost Accounting Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every executable provider operation record measurable usage and a locally versioned cost state, then prove it against the current database-backed runtime.

**Architecture:** Keep `meterProviderMethod` as the common provider-operation seam. Extend provider result contracts to preserve AI SDK usage, explicitly meter direct dual-source and asynchronous-review calls, and seed a versioned rule for every executable provider operation; unavailable prices remain `unknown`, never zero.

**Tech Stack:** TypeScript, Node test runner, Fastify, Prisma/PostgreSQL, AI SDK.

---

### Task 1: Repair and extend metering-contract tests

**Files:**
- Modify: `src/services/providerOperationMeter.test.ts`
- Modify: `src/features/appearance-agent/providers/styleRecommendation/multimodalAgentRecommendation.test.ts`
- Modify: `src/features/dual-source-recommendation/*.test.ts`

- [x] **Step 1: Add failing expectations for uncached tokens and direct-provider usage.**
- [x] **Step 2: Run focused tests and observe the missing usage propagation.**
- [x] **Step 3: Preserve `usage` through multimodal and dual-source adapter results.**
- [x] **Step 4: Re-run focused tests.**

### Task 2: Meter every direct executable provider operation

**Files:**
- Modify: `src/features/dual-source-recommendation/zhipuChannelProvider.ts`
- Modify: `src/features/dual-source-recommendation/reviewer.ts`
- Modify: `src/features/appearance-agent/composition.ts`

- [x] **Step 1: Add failing recorder assertions for direct Zhipu channels and the DeepSeek reviewer.**
- [x] **Step 2: Route successful and failed direct operations through the shared recorder.**
- [x] **Step 3: Re-run focused tests.**

### Task 3: Complete local rule coverage

**Files:**
- Create: `prisma/migrations/20260729050000_complete_provider_cost_rules/migration.sql`
- Modify: `src/services/providerCostAccounting.test.ts`

- [x] **Step 1: Add a failing coverage test for every current provider-operation identity.**
- [x] **Step 2: Seed known/free/unknown rules with source metadata for every identity.**
- [x] **Step 3: Apply the migration and verify rows in local PostgreSQL.**

### Task 4: Regression verification and current-environment integration

**Files:**
- Modify: `openspec/changes/add-provider-cost-accounting/tasks.md`

- [x] **Step 1: Reproduce and repair the weather timeout test independently of accounting.**
- [x] **Step 2: Run typecheck and the complete service test suite serially.**
- [x] **Step 3: Verify migrated rules and a recorder write through the current PostgreSQL-backed container.**
- [x] **Step 4: Mark only verified OpenSpec tasks complete.**
