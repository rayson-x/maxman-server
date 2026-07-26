## ADDED Requirements

### Requirement: Multi-Layer Input Moderation
The system SHALL run every uploaded photo through an image content-safety API (nudity, minors, non-self photo, public figure detection) before it becomes eligible for analysis, and run all free-text questionnaire input through a text content-safety API.

#### Scenario: Photo passes moderation
- **WHEN** a `UserPhoto` in `moderation_status=pending` passes the image content-safety API
- **THEN** the server sets `moderation_status=passed` and the photo becomes eligible for inclusion in an `AnalysisJob`

#### Scenario: Photo fails moderation
- **WHEN** a `UserPhoto` fails the image content-safety API (e.g. detected as a non-self or minor photo)
- **THEN** the server sets `moderation_status=failed` with a reason code, the photo is excluded from analysis, and the client shows a clear re-upload prompt

### Requirement: Output Moderation Before Publishing
The system SHALL run every generated target image through the image content-safety API and every generated text (diagnosis, task rationale, style explanation) through LLM contextual safety review before the result is made visible to the user.

#### Scenario: Generated image fails output moderation
- **WHEN** a generated `TargetImage` fails output moderation
- **THEN** the system does not mark the associated job as completed with that image, retries generation once, and marks the job `failed` (without consuming any generation quota concept, per `target-image-generation` spec) if the retry also fails

### Requirement: Deterministic Safety Backstop
The system SHALL apply a final deterministic rule-based block independent of model judgment for hard-coded red lines (e.g. detected minor facial features), which cannot be overridden by any upstream model output.

#### Scenario: Deterministic block overrides model approval
- **WHEN** an upstream moderation model marks content as passed but the deterministic rule set detects a hard-coded red-line condition
- **THEN** the request is blocked regardless of the model's verdict
