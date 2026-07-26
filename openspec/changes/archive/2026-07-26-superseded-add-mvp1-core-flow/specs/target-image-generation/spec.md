## ADDED Requirements

### Requirement: Generation Always Anchored to Original Baseline Photo
The system SHALL generate every `TargetImage` using the user's original baseline photo plus the accumulated `ChangeManifestEntry` records as of that point, and SHALL NOT use a previously generated `TargetImage` as the input for a subsequent generation.

#### Scenario: Stage 2 generation uses baseline photo, not stage 1's generated image
- **WHEN** the system generates a target image for stage 2
- **THEN** the `ImageEditProvider` call's image input is the original baseline photo, and the cumulative changes from stage 0 and stage 1 are passed as the `ChangeManifestEntry` list, not as an intermediate generated image

### Requirement: Automatic Change Manifest Entry Creation
The system SHALL automatically create a `ChangeManifestEntry` when a user marks a `StageTask` as done, copying that task's pre-authored `change_description` field verbatim. No LLM call SHALL be involved in creating this entry, and skipped/incomplete tasks SHALL NOT produce an entry.

#### Scenario: Completing a task creates a manifest entry
- **WHEN** a user marks a `StageTask` with a non-empty `change_description` as done
- **THEN** the system creates a `ChangeManifestEntry` copying that description, without calling any AI provider

#### Scenario: Skipped task creates no entry
- **WHEN** a user marks a `StageTask` as skipped
- **THEN** no `ChangeManifestEntry` is created for that task

### Requirement: Two Target Image Types Per Stage
The system SHALL generate up to two distinct target images per stage: a face/hair image and a full-body outfit image, each with its own change explanation (what changed, method, expected time, simulated-effect disclaimer, unchanged features).

#### Scenario: Both image types generated independently
- **WHEN** a `stage_unlock_generation` job runs for a stage with both hair and outfit changes in its manifest
- **THEN** the system produces one `face_hair` TargetImage and one `full_body_outfit` TargetImage, each with independent change explanations

### Requirement: Identity and Body Preservation Constraints
The system SHALL constrain every generation to preserve facial structure, face shape, realistic hair density, height, shoulder width/skeleton, and SHALL NOT apply long-term fat-loss/muscle-gain effects to short-term-stage images.

#### Scenario: Quality check rejects identity drift
- **WHEN** automated quality checking detects that a generated image alters facial structure or body proportions beyond configured tolerance
- **THEN** the generation is treated as a quality-check failure and follows the single-retry-then-fail path defined in `appearance-analysis`

### Requirement: Generation Trigger Semantics for MVP1
The system SHALL support the three post-initial-analysis generation triggers (`stage_unlock_generation`, `user_regeneration`, `progress_recheck`) without enforcing any weekly quota limit in MVP1 (quota fields exist in the data model for forward compatibility but are not enforced as a gate in this phase).

#### Scenario: Regeneration allowed without quota check
- **WHEN** a user requests `user_regeneration` for the current stage's target image
- **THEN** the system processes the request regardless of how many prior regenerations occurred in the current period

### Requirement: Progress Recheck Recalibration
The system SHALL allow a user to submit a real progress photo, triggering a `progress_recheck` job that produces a recalibrated plan (via `plan_version` increment), an updated `TargetImage`, and a real before/after comparison.

#### Scenario: Progress photo triggers recalibration
- **WHEN** a user uploads a progress photo via `POST /plans/:id/recheck`
- **THEN** the system creates a `progress_recheck` `AnalysisJob`, and upon completion updates the active `AppearancePlan` in place with a real before/after comparison available to the client
