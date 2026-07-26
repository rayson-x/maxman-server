## ADDED Requirements

### Requirement: Basic Low-Sensitivity Questionnaire Submission
The system SHALL accept a basic questionnaire (age range, height, weight) via `POST /questionnaire/basic` before the user provides any photo, and store it against the current session's `User`/`AppearanceProfile`.

#### Scenario: Submit basic questionnaire
- **WHEN** a client submits age range, height, and weight for the current session
- **THEN** the server creates or updates the `AppearanceProfile` record linked to the session's `User`

### Requirement: Full Questionnaire Submission
The system SHALL accept a full questionnaire via `POST /questionnaire/full` covering: track selection (short-term scenario vs. long-term), scenario type and target date (only when short-term), domain selections (hair/outfit, skincare, fitness), per-domain acceptance level, and budget tier.

#### Scenario: Short-term track with scenario and date
- **WHEN** a client submits track=short_term with a scenario type and target date
- **THEN** the server creates an `Event` record linked to the user and stores it for later use as a soft constraint in plan generation

#### Scenario: Long-term track skips scenario fields
- **WHEN** a client submits track=long_term without scenario/date fields
- **THEN** the server accepts the submission without requiring `Event` fields and leaves `Event` unset for this user

#### Scenario: Domain selection and acceptance stored
- **WHEN** a client submits domain selections and acceptance levels (e.g. accepts light makeup, does not accept perming)
- **THEN** the server stores `domain_selections` and `domain_acceptance` on `AppearanceProfile` for use as the candidate task pool boundary in analysis

### Requirement: Structural Validation of Contradictory Answers
The system SHALL detect direct contradictions between questionnaire answers (e.g. rejecting makeup while separately accepting foundation) and reject the submission with a clear error rather than silently accepting inconsistent data.

#### Scenario: Contradictory acceptance answers rejected
- **WHEN** a submission contains mutually exclusive acceptance answers
- **THEN** the server returns a validation error identifying the conflicting fields instead of persisting the submission
