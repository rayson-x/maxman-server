## ADDED Requirements

### Requirement: Target Image Represents the End of the Current Stage
The system SHALL generate each stage's target image from the original baseline photo plus all completed `ChangeManifestEntry` records plus the planned changes of that stage's `core` tasks, so the image depicts what the user will look like after finishing the stage.

#### Scenario: Newly unlocked stage shows a forward-looking image
- **WHEN** a stage unlocks and its target image is generated
- **THEN** the image already reflects that stage's planned core changes, so it differs visibly from the previous stage's image rather than being identical to it

#### Scenario: Optional tasks do not affect the target image
- **WHEN** a stage contains optional tasks alongside core tasks
- **THEN** only the core tasks' planned changes contribute to the target image, so skipping or replacing an optional task never triggers regeneration

#### Scenario: Completing tasks within a stage does not regenerate the image
- **WHEN** a user marks core tasks of the active stage as done
- **THEN** no new target image is generated for that stage, because the existing image already depicts the completed state

#### Scenario: Generation is always anchored to the baseline photo
- **WHEN** a later stage's target image is generated
- **THEN** the image input is the original baseline photo with the cumulative changes expressed as instructions, never a previously generated image

### Requirement: Stable Per-User Generation Seed
The system SHALL persist a generation seed on the user's plan and reuse it for every target-image generation, so the four stages' images read as one person's progression.

#### Scenario: Successive stage images stay visually consistent
- **WHEN** target images are generated for stages one through three
- **THEN** they use the same stored seed, avoiding the incidental variation that a random seed produces between calls

### Requirement: Task Completion Is Self-Reported Without Photo Verification
The system SHALL allow a user to mark a task done without submitting any photo evidence, and SHALL write the task's pre-authored `change_description` into a `ChangeManifestEntry` on completion.

#### Scenario: Completion requires no verification
- **WHEN** a user marks a core task done
- **THEN** the transition succeeds without requiring a photo, and a manifest entry is created with no AI call

#### Scenario: Skipped tasks produce no manifest entry
- **WHEN** a user marks an optional task skipped
- **THEN** no manifest entry is created

#### Scenario: Target images disclose that progress is self-reported
- **WHEN** a target image is presented to the user
- **THEN** it carries a label indicating it is based on the completion status the user marked

### Requirement: Stage Unlock Requires All Core Tasks Done
The system SHALL unlock the next stage only when every `core` task in the current stage is done, evaluated live from task records rather than from a cached counter, with optional tasks excluded from the decision entirely.

#### Scenario: Unlock occurs when all core tasks complete
- **WHEN** the last remaining core task in the active stage is marked done
- **THEN** the current stage is marked completed, the next stage becomes active, and a target-image generation job is enqueued for it

#### Scenario: Remaining core task blocks unlock
- **WHEN** a stage has multiple core tasks and only some are done
- **THEN** the stage does not unlock regardless of how many optional tasks are complete

#### Scenario: Core tasks cannot be skipped
- **WHEN** a user attempts to skip a core task
- **THEN** the transition is rejected, and replacement is offered instead

### Requirement: Target Image Failure Does Not Block Stage Progression
The system SHALL treat the target image as a motivational artifact rather than a prerequisite, allowing a stage to unlock and its tasks to be worked on even when image generation fails.

#### Scenario: Stage proceeds despite image failure
- **WHEN** a stage's target-image generation fails after its retry
- **THEN** the stage is still unlocked and its task list is fully available, with the image slot showing a retry affordance

#### Scenario: Failed generation consumes no quota
- **WHEN** a target-image generation fails
- **THEN** it is not recorded as having consumed the user's regeneration quota
