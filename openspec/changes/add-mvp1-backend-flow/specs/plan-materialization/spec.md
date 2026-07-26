## ADDED Requirements

### Requirement: Stage Assignment Is Determined by Time Scale, Not Priority
The system SHALL assign each task to a stage based on that task's inherent time scale as declared in its catalog entry's `applicable_stage_range`, and SHALL NOT let the priority scoring formula determine which stage a task lands in.

#### Scenario: A high-priority long-duration task is not placed in an early stage
- **WHEN** a task with a multi-week time scale (e.g. fitness-driven change) receives the highest priority score
- **THEN** it is still assigned to a later stage matching its time scale, not to the same-day stage

#### Scenario: A low-priority quick task can occupy the earliest stage
- **WHEN** a task takes ten minutes and scores low on priority
- **THEN** it can still be assigned to the same-day stage, because stage placement follows duration rather than score

#### Scenario: Scoring determines core versus optional within a stage
- **WHEN** tasks have been assigned to a stage
- **THEN** the weighted formula is applied within that stage to mark each task `core` or `optional` and to set `sort_order`

### Requirement: All Four Stages' Task Lists Are Generated at Once
The system SHALL generate the complete task list for all four stages in a single materialization step, rather than deferring later stages' task details until those stages unlock.

#### Scenario: Full roadmap is visible immediately
- **WHEN** plan materialization completes
- **THEN** the user can see the concrete tasks for all four stages, not just time windows and direction summaries for future stages

#### Scenario: Materialization uses a single scoring pass
- **WHEN** tasks are scored for core/optional classification
- **THEN** one scoring call covers the entire candidate set, rather than one call per stage

### Requirement: Style-Derived Tasks and Domain Tasks Are Both Materialized
The system SHALL expand the selected style into concrete hairstyle and outfit tasks, and SHALL additionally draw tasks for non-style domains from the curated method catalog.

#### Scenario: Selected style becomes executable tasks
- **WHEN** a user has selected a hairstyle and an outfit direction
- **THEN** these become concrete tasks (e.g. getting the specified cut, acquiring or altering the specified garment category) carrying pre-authored `change_description` values

#### Scenario: Non-style domains are drawn from the catalog
- **WHEN** the plan is materialized
- **THEN** applicable entries from the curated method catalog for grooming, skincare, fitness, and posture are included, filtered by the user's questionnaire and analysis results

#### Scenario: Method catalog remains the only source of non-style methods
- **WHEN** non-style tasks are selected
- **THEN** they come only from catalog entries marked recommended, and no method outside the catalog is generated

### Requirement: Stage Zero Contains No Target Image
The system SHALL NOT generate a target image for stage zero.

#### Scenario: Stage zero delivers a task list only
- **WHEN** plan materialization completes and stage zero becomes active
- **THEN** the user receives stage zero's task checklist with no target image, because stage zero's grooming-level changes produce negligible visual difference

#### Scenario: Target images begin at stage one
- **WHEN** the first stage unlock occurs
- **THEN** that is the first point at which a target image is generated

### Requirement: Guided Selection Candidates Carry Their Own Change Descriptions
The system SHALL store, for each candidate offered in a guided-selection task, that candidate's own `change_description`, so the selected option can be written directly into the stage's planned changes.

#### Scenario: Selecting a candidate yields a usable planned change
- **WHEN** a user selects one of a guided-selection task's candidates
- **THEN** that candidate's `change_description` becomes the stage's planned change for target-image generation, with no further model call needed

#### Scenario: Candidate list is not a bare tag list
- **WHEN** a guided-selection task is created
- **THEN** each candidate carries both its `style_tag` and its own change description, rather than the task holding only a list of tag strings
