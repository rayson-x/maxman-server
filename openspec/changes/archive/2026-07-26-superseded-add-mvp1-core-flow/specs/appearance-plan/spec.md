## ADDED Requirements

### Requirement: Single Active Plan Per User
The system SHALL maintain exactly one active `AppearancePlan` per user. Recalibration events (e.g. `progress_recheck`) SHALL update the existing plan in place and increment `plan_version`, rather than creating a new plan row.

#### Scenario: Recalibration increments version in place
- **WHEN** a `progress_recheck` job completes and changes stage content
- **THEN** the existing `AppearancePlan` row is updated and its `plan_version` is incremented; no new `AppearancePlan` row is created

#### Scenario: Historical evolution is traceable via WorkflowRun
- **WHEN** someone needs to inspect how the plan changed over time
- **THEN** they can reconstruct history from the `WorkflowRun` audit records rather than from multiple `AppearancePlan` rows

### Requirement: Stage Structure with Four Time-Window Stages
The system SHALL organize every plan into four stages by time window (stage 0: same-day 10-30min; stage 1: 1-7 days; stage 2: 2-4 weeks; stage 3: 6-12 weeks), not by domain. Every user SHALL start at stage 0 regardless of short-term or long-term track.

#### Scenario: Long-term track still starts at stage 0
- **WHEN** a user selected the long-term track
- **THEN** their plan still begins at stage 0 to deliver an immediate quick win before progressing

### Requirement: Flat, Non-Dated Stage Task List
The system SHALL represent each stage's tasks as a flat checklist (`StageTask`) without per-day date assignment. Users SHALL be free to complete tasks in any order and at any pace within the stage's time window.

#### Scenario: Tasks have no due date
- **WHEN** a `StageTask` is created
- **THEN** it has no `task_date` field and is simply associated with its `stage_id`, `priority` (core/optional), and a `sort_order` suggestion

### Requirement: Stage Unlock Requires All Core Tasks Done
The system SHALL unlock the next stage only when every `StageTask` with `priority=core` in the current stage is marked `done` (or `replaced` by an equivalent core task that is itself done). A stage may have multiple core tasks spanning different domains (e.g. hairstyle and outfit both core in the same stage), and ALL of them must be done — completing only some core tasks, regardless of overall completion percentage, SHALL NOT unlock the next stage. Optional tasks SHALL NOT factor into the unlock decision at all. No photo verification SHALL be required for unlock. Core-task completion SHALL be evaluated live from `StageTask` records at unlock-check time, not from a cached boolean/counter on `Stage`.

#### Scenario: Unlock triggered when all core tasks done
- **WHEN** every core `StageTask` in the current stage is `done`
- **THEN** the system marks the current stage `completed`, triggers a `stage_unlock_generation` job for the next stage, and marks the next stage `active`, regardless of how many optional tasks remain `pending`

#### Scenario: Unlock blocked while any core task remains incomplete
- **WHEN** a stage has two core tasks (e.g. haircut and outfit purchase) and only one is done
- **THEN** the stage does NOT unlock, even if all optional tasks in the stage are done

#### Scenario: Unlock not triggered by optional tasks alone
- **WHEN** a user has completed every optional task but at least one core task remains `pending` or `blocked`
- **THEN** the stage does NOT unlock

### Requirement: Task Status Transitions
The system SHALL support task status values `pending`, `done`, `skipped`, `blocked`, `replaced` via `POST /plans/:id/stages/:stageId/tasks/:taskId/status`. Core tasks SHALL NOT be skippable directly — only replaceable with an equivalent task.

#### Scenario: Optional task can be skipped
- **WHEN** a user marks an optional `StageTask` as skipped
- **THEN** the status updates to `skipped` and does not block stage unlock calculation beyond reducing the completion percentage

#### Scenario: Core task cannot be skipped
- **WHEN** a user attempts to mark a core `StageTask` as skipped
- **THEN** the server rejects the transition and only allows `replaced` as an alternative

### Requirement: Plan Retrieval API
The system SHALL expose `GET /plans/:id` returning current state summary, stage timeline, generated target images (where available), and sub-plans (haircut card, outfit plan, skincare plan). In MVP1, all fields SHALL be returned unlocked (no subscription gating).

#### Scenario: Ungenerated future stage shows skeleton only
- **WHEN** a client requests a plan where stage 2's detailed tasks have not yet been generated (still pending `stage_unlock_generation`)
- **THEN** the response includes stage 2's time window and direction summary but not a detailed task list, reflecting the lazy-generation design

### Requirement: Current-Plan Convenience Alias
The system SHALL expose `GET /plans/current`, which resolves the requesting session's single active `AppearancePlan` and returns the same response shape as `GET /plans/:id`, so the client never needs to look up or store a plan id separately.

#### Scenario: Client fetches its own plan without knowing the id
- **WHEN** a client with a valid `device_session_id` calls `GET /plans/current`
- **THEN** the server resolves the session's active `AppearancePlan` and returns the identical payload `GET /plans/:id` would return for that plan's id

#### Scenario: No per-stage task endpoint exists
- **WHEN** a client needs a specific stage's task list
- **THEN** it reads that stage's tasks from the full payload already returned by `GET /plans/current` (or `GET /plans/:id`) — there is no separate `GET /plans/:id/stages/:stageId/tasks` endpoint

### Requirement: Static Reference Guide Lookup for Task Instructions
The system SHALL maintain a human-curated `StyleReferenceGuide` table mapping a fixed set of `style_tag` values (e.g. hairstyle categories such as "微碎盖", "寸头", "飞机头", "背头", "纹理烫") to a reference URL, reference type, and human-written summary text. When generating a `StageTask` whose content matches one of the known tags, the system SHALL have `TextPlanningProvider` classify the task into one of the predefined `style_tag` values (never invent a new tag or a URL itself), and the backend SHALL attach the corresponding `StyleReferenceGuide` entry to the task. Tasks that do not match any known tag SHALL be shown with generic text instructions only, without a reference link.

#### Scenario: Task matches a known style tag
- **WHEN** a generated `StageTask` is about a hairstyle covered by `StyleReferenceGuide` (e.g. the user's target style is classified as "微碎盖")
- **THEN** the task response includes the matched `style_tag`, the reference URL, reference type, and curated summary text from `StyleReferenceGuide`

#### Scenario: No matching style tag falls back to text-only
- **WHEN** a generated `StageTask`'s content does not correspond to any entry in `StyleReferenceGuide`
- **THEN** the task is shown with only its generated text instructions (`rationale`/`completion_criteria`) and no reference link, rather than an incorrect or fabricated link

#### Scenario: LLM does not generate URLs directly
- **WHEN** `TextPlanningProvider` processes a task that could reference styling instructions
- **THEN** the model's output is limited to selecting a `style_tag` from the predefined set (or none), and the actual URL/summary always comes from the `StyleReferenceGuide` lookup table, never from the model's own text generation

### Requirement: Guided Selection Tasks Are a Distinct Interaction Type
The system SHALL support two `StageTask` interaction types: `simple` (completed/skipped directly on the task card) and `guided_selection` (requires the user to first make a choice on a dedicated selection screen before the task can proceed to execution). Every `StageTask` SHALL carry a `selection_status` with three possible values: `not_applicable` (always the value for `simple` tasks), `pending_selection`, or `selected` (the latter two only apply to `guided_selection` tasks). `selection_status` is independent of the task's `status` (`pending`/`done`/`skipped`/`blocked`/`replaced`). Selecting an option SHALL NOT by itself mark the task `done` and SHALL NOT create a `ChangeManifestEntry`.

#### Scenario: Simple task selection_status is always not_applicable
- **WHEN** a `simple` StageTask is created or updated
- **THEN** its `selection_status` is `not_applicable` and never transitions to `pending_selection` or `selected`

#### Scenario: Guided task starts in pending_selection
- **WHEN** a `stage_unlock_generation` job creates a `guided_selection` StageTask (e.g. a hairstyle-change task)
- **THEN** the task is created with `selection_status=pending_selection`, a non-empty `candidate_style_tags` list, and `status=pending`

#### Scenario: Selecting an option updates selection_status only
- **WHEN** a user submits a choice via `POST /plans/:id/stages/:stageId/tasks/:taskId/select` with one of the task's `candidate_style_tags`
- **THEN** the system sets `style_tag` to the chosen value and `selection_status=selected`, but `status` remains unchanged (still `pending`) and no `ChangeManifestEntry` is created

#### Scenario: Task completion still requires explicit user confirmation after the real-world action
- **WHEN** a user has a `guided_selection` task with `selection_status=selected`
- **THEN** the task can only transition to `status=done` through the same `POST .../status` endpoint used by simple tasks, representing that the user actually completed the real-world action (e.g. got the haircut), at which point the task's `change_description` is written to a `ChangeManifestEntry` as usual

#### Scenario: Candidate options come from a predefined tag set
- **WHEN** the system generates `candidate_style_tags` for a `guided_selection` task
- **THEN** `TextPlanningProvider` selects 2-4 tags from the predefined `style_tag` set (the same set used by `StyleReferenceGuide`), rather than inventing new tag values
