## ADDED Requirements

### Requirement: Explicit Analysis Trigger
The system SHALL only start a full analysis when the client explicitly calls `POST /analysis-jobs` after questionnaire and required photos are complete and passed moderation; the server SHALL NOT auto-trigger analysis on data completeness alone.

#### Scenario: Trigger accepted when data complete
- **WHEN** a client calls `POST /analysis-jobs` and the user's questionnaire and required photos are complete and moderation-passed
- **THEN** the server creates an `AnalysisJob` with `job_type=full_analysis` and status `created`, then transitions it into the processing pipeline

#### Scenario: Trigger rejected when data incomplete
- **WHEN** a client calls `POST /analysis-jobs` but required questionnaire fields or photos are missing
- **THEN** the server returns a validation error and does not create an `AnalysisJob`

### Requirement: AnalysisJob State Machine
The system SHALL track every analysis/generation job through the state machine: `created → uploading → input_moderating → analyzing → planning → generating → output_moderating → quality_checking → completed`, with `failed` and `cancelled` as terminal states reachable from any non-terminal state. Clients SHALL be able to poll `GET /analysis-jobs/:id` to read the current state.

#### Scenario: Client polls job progress
- **WHEN** a client polls `GET /analysis-jobs/:id` while the job is in progress
- **THEN** the server returns the current state and, once available, partial results (e.g. text diagnosis before image generation completes)

#### Scenario: Quality check failure triggers single retry
- **WHEN** a job's generated output fails `quality_checking`
- **THEN** the system automatically retries generation exactly once; if the retry also fails, the job transitions to `failed`

### Requirement: AnalysisJob Type Taxonomy
The system SHALL support four distinct `job_type` values, each mapped to a specific business trigger: `full_analysis` (first-time analysis after questionnaire+photos), `stage_unlock_generation` (first entry into a stage, including stage 0), `user_regeneration` (user-initiated target image regeneration), and `progress_recheck` (user-submitted progress photo triggering free recalibration).

#### Scenario: Full analysis produces stage skeleton, not per-stage task details
- **WHEN** a `full_analysis` job completes
- **THEN** the system has created the four `Stage` records with time windows and a ranked candidate task pool, plus a text diagnosis, but has NOT generated the detailed `StageTask` list for stages 1-3 and has NOT generated any `TargetImage`

#### Scenario: Stage unlock generation produces stage-specific tasks and image
- **WHEN** a `stage_unlock_generation` job runs for a given stage
- **THEN** the system generates that stage's `StageTask` list (informed by prior stage completion/recheck data if available) and a `TargetImage` for that stage, using the original baseline photo and accumulated `ChangeManifestEntry` records

### Requirement: AnalysisJob to WorkflowRun Relationship
The system SHALL relate one `AnalysisJob` to one or more `WorkflowRun` records (a one-to-many relationship): `full_analysis` jobs internally trigger a text-analysis `WorkflowRun`; jobs that also involve image generation (`stage_unlock_generation`, `user_regeneration`, `progress_recheck`) trigger an additional image-generation `WorkflowRun`.

#### Scenario: Full analysis job produces one WorkflowRun
- **WHEN** a `full_analysis` job runs to completion
- **THEN** exactly one `WorkflowRun` record (text-analysis pipeline) is created and linked to the `AnalysisJob`

#### Scenario: Image-only job produces one WorkflowRun
- **WHEN** a `user_regeneration` job runs to completion
- **THEN** exactly one `WorkflowRun` record (image-generation pipeline) is created and linked to the `AnalysisJob`

### Requirement: Mastra Workflow Runs on a Dedicated Worker Process
The system SHALL execute all Mastra workflow steps in a worker process separate from the Fastify API process; the API process SHALL only enqueue jobs and read persisted state, never execute a Mastra workflow inline within an HTTP request handler.

#### Scenario: API request returns immediately after enqueueing
- **WHEN** a client triggers an analysis or regeneration action via the API
- **THEN** the API process writes a queue message and returns a job id/status without waiting for the AI processing to complete

### Requirement: Rule-Based Priority Scoring with LLM-Provided Dimension Scores
The system SHALL have the `TextPlanningProvider` output raw per-dimension scores (visual benefit, credibility, acceptance, reversibility, time cost, money cost, risk, time-window fit) for each candidate task, and SHALL compute the final ranking and stage assignment using a fixed, server-configurable weighted formula — not by asking the model to rank directly.

#### Scenario: Ranking is deterministic given scores and weights
- **WHEN** the same set of per-dimension scores and configured weights are provided
- **THEN** the computed ranking and stage assignment are identical every time (no LLM call involved in the ranking step itself)

#### Scenario: Model explains but does not decide order
- **WHEN** the ranking has been computed by the backend formula
- **THEN** a separate LLM call may be used only to generate human-readable rationale text for each ranked item, without altering the order

### Requirement: Evidence Basis Gates Core Task Eligibility
The system SHALL classify every candidate task with an `evidence_basis` of `visual_detected` (identified by `VisionAnalysisProvider` from the user's photos), `self_reported` (derived from questionnaire answers), or `general_best_practice` (not verifiable from either photo or questionnaire, e.g. odor/hygiene management, social behavior habits, sunscreen/preventive advice, or items the current photo set cannot reliably capture such as teeth or hand close-ups). This classification SHALL be applied as a hard filter BEFORE the weighted-formula scoring in the priority engine, not as one of the scored dimensions. Tasks classified `general_best_practice` SHALL always be assigned `priority=optional` regardless of their computed score, and SHALL NEVER be assigned `priority=core`.

#### Scenario: Visually detected issue can become core
- **WHEN** `VisionAnalysisProvider` identifies a visible condition (e.g. uneven skin tone, ill-fitting outfit, visible hairline recession) from the user's photos
- **THEN** the corresponding candidate task is classified `visual_detected` and is eligible for `priority=core` if its weighted score qualifies

#### Scenario: General best-practice task cannot become core
- **WHEN** a candidate task's content cannot be confirmed by any photo analysis or questionnaire answer (e.g. "use antiperspirant", "practice better eye contact", "wear sunscreen")
- **THEN** the task is classified `general_best_practice`, is always assigned `priority=optional`, and its generated rationale text uses generic-recommendation phrasing ("this tends to help") rather than personalized-diagnosis phrasing ("we detected that you...")

#### Scenario: High computed score does not override the evidence gate
- **WHEN** a `general_best_practice` task receives a high weighted score from the priority formula
- **THEN** the system still assigns it `priority=optional`, since the evidence-basis gate is applied independently of and prior to the score

### Requirement: Candidate Tasks Sourced from a Curated Catalog, Not Freely Generated
The system SHALL maintain a human-curated `CandidateTaskCatalog` table (transformation methods across domains: hair, face/grooming, outfit/accessories, posture, fitness, body odor, dental, other), each entry carrying its own `evidence_basis`, time/cost/reversibility/risk attributes, applicable stage range, and an `is_recommended` flag. `TextPlanningProvider` SHALL only select and score entries from this catalog where `is_recommended=true`, matching them to the user's questionnaire answers, visual analysis results, and accepted domains; it SHALL NOT invent transformation methods outside the catalog. Catalog entries marked `is_recommended=false` (e.g. methods with insufficient evidence such as mewing/jawline exercisers) SHALL never be selected as candidates, regardless of how well they might otherwise match the user.

#### Scenario: Model selects from the catalog rather than inventing a method
- **WHEN** `TextPlanningProvider` generates candidate tasks for a user's plan
- **THEN** every candidate task traces back to a specific `CandidateTaskCatalog` entry with `is_recommended=true`; the model does not introduce a transformation method absent from the catalog

#### Scenario: Non-recommended catalog entries are never surfaced
- **WHEN** the catalog contains an entry marked `is_recommended=false` with an `exclusion_reason` (e.g. a jaw-exercise method lacking scientific evidence)
- **THEN** that entry is excluded from candidate selection entirely, even if it would otherwise match the user's domain selections well

#### Scenario: Catalog entry's evidence_basis flows through to the generated task
- **WHEN** a `StageTask` is generated from a `CandidateTaskCatalog` entry
- **THEN** the task's `evidence_basis` is taken from the catalog entry (not independently re-derived), keeping the core/optional gate consistent with the catalog's own classification
