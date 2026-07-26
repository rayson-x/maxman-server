## ADDED Requirements

### Requirement: Progress Recheck Reconciles the Manifest Against Reality
The system SHALL, on receiving a progress photo, compare the changes the manifest claims against what the photo shows, correct the manifest where they diverge, regenerate the target image from the corrected manifest, and increment `plan_version`.

#### Scenario: Divergence corrects the manifest
- **WHEN** the manifest records a change as completed but the progress photo indicates it has not happened
- **THEN** the corresponding manifest entry is marked unverified or rolled back, and the target image is regenerated from the corrected manifest

#### Scenario: Divergence is communicated as collaboration, not accusation
- **WHEN** the system detects a divergence
- **THEN** it asks whether to update the recorded progress, rather than asserting the user reported falsely

#### Scenario: Confirmation strengthens the manifest
- **WHEN** the progress photo is consistent with the manifest
- **THEN** the affected entries are marked verified and the plan version is incremented without content changes

### Requirement: Style Change Is Constrained by Already-Completed Changes
The system SHALL allow a user to change their selected style, SHALL retain all completed `ChangeManifestEntry` records, and SHALL restrict the new style candidate set to styles compatible with those completed changes.

#### Scenario: Completed facts are never erased
- **WHEN** a user changes style after completing a hairstyle change
- **THEN** the completed manifest entry is retained, because it records something that actually happened

#### Scenario: New candidates respect what already happened
- **WHEN** the new style candidate set is computed
- **THEN** it excludes styles whose style vector is incompatible with the already-completed changes, using the same compatibility computation as initial recommendation

#### Scenario: Empty candidate set is expressed as a time expectation
- **WHEN** compatibility filtering leaves no available style because of an irreversible completed change
- **THEN** the system states how long until that direction becomes feasible and offers the directions available now, rather than reporting a bare failure

#### Scenario: Style change increments rather than resets the plan
- **WHEN** a style change completes
- **THEN** the existing plan row is updated and `plan_version` is incremented, with no new plan row created

### Requirement: Style-Derived Tasks Are Replaced Only via Style Change
The system SHALL NOT allow a hairstyle or outfit task to be replaced individually, and SHALL route such a request through the style-change flow.

#### Scenario: Individual hairstyle replacement is refused
- **WHEN** a user attempts to replace only the hairstyle task while keeping the outfit
- **THEN** the system routes them to the style-change flow, because replacing one half would break the coherence guarantee

#### Scenario: Non-style tasks can be replaced individually
- **WHEN** a user requests replacement of a grooming, skincare, fitness, or posture task
- **THEN** an equivalent entry from the same catalog domain replaces it, and the task's status becomes `replaced`

### Requirement: Conversational Revision Is Billable and Rate-Limited Independently
The system SHALL allow users to adjust goals, plans, and target images conversationally through the `user_regeneration` path, SHALL record quota consumption on every such generation, and SHALL apply a capacity rate limit that is independent of any billing gate.

#### Scenario: Quota is recorded even while unenforced
- **WHEN** a conversational adjustment triggers a target-image regeneration in MVP1
- **THEN** the generation is recorded as having consumed quota, even though no quota gate blocks it, so the data supports later pricing calibration

#### Scenario: Capacity limit protects other users
- **WHEN** one user requests generation-triggering adjustments repeatedly within a short period
- **THEN** a per-user hourly cap on generation operations prevents them from monopolizing the globally serialized generation queue

#### Scenario: Capacity limit persists after billing launches
- **WHEN** payment and quota enforcement are eventually enabled
- **THEN** the capacity rate limit remains in force, because it addresses queue capacity rather than pricing

### Requirement: Conversation Retains Structured Decisions, Not Transcript Text
The system SHALL persist only the structured decisions reached during a conversation — which style was chosen, which directions were rejected and why — and SHALL NOT persist the conversation's raw message text.

#### Scenario: Later turn resolves a reference to an earlier decision
- **WHEN** a user asks a follow-up that depends on a prior turn (e.g. asking about the alternative they were previously shown)
- **THEN** the agent resolves it from the stored structured decisions plus the current plan state, rather than from stored message text

#### Scenario: Rejected directions are not re-offered
- **WHEN** a user has previously rejected a direction with a stated reason
- **THEN** that rejection is retained as a structured record so the direction is not presented again as if it were new

#### Scenario: Deletion carries no transcript burden
- **WHEN** a user exercises data deletion
- **THEN** there is no conversation transcript to cascade-delete, because none was stored

### Requirement: Conversational Agent Shares the Pipeline's Step Implementations
The system SHALL expose workflow steps to the conversational agent as individually invocable units backed by the same implementations the fixed pipeline uses, with the agent's available tool set determined by injection rather than by duplicated logic.

#### Scenario: Conversation and pipeline cannot diverge in behavior
- **WHEN** a user adjusts their outfit direction conversationally
- **THEN** the same step implementation runs as during initial onboarding, so the outcome matches what the pipeline would have produced

#### Scenario: Tool availability is configured, not hard-coded
- **WHEN** the conversational agent is constructed with a restricted capability set
- **THEN** the restriction is expressed by which tools are injected, requiring no change to any tool or step implementation
