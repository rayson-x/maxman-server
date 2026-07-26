## ADDED Requirements

### Requirement: Hybrid Intake — Structured Form Plus a Gated Free-Input Step
The system SHALL collect all fields the scoring pipeline depends on (`track`, budget tier, domain selections, age, height, weight, exercise habit, and optional detailed measurements) through a structured form, and SHALL collect the user's own style preference through a separate explicit yes/no gate that reveals a free-input field only when the user answers yes.

#### Scenario: User has no preference in mind
- **WHEN** a user answers "no" to the hairstyle-preference gate
- **THEN** the system skips the free-input step entirely and proceeds with recommendation-only flow, without asking the user to describe anything

#### Scenario: User has a preference in mind
- **WHEN** a user answers "yes" to the hairstyle-preference gate
- **THEN** the system reveals a free-input field, accepts the user's description, and routes it through the two-layer review before it can influence generation

#### Scenario: Pipeline-critical fields are never collected conversationally
- **WHEN** the intake flow gathers `track`, budget tier, or domain selections
- **THEN** these come from structured form controls, so the pipeline always receives complete, valid values without needing to verify that a conversation covered them

### Requirement: Self-Reported Hair Loss Concern
The system SHALL include a questionnaire item asking whether the user is troubled by hair loss or reduced hair volume, and SHALL persist the answer to `AppearanceProfile.hair_loss_concern` with `evidence_basis: self_reported`.

#### Scenario: Self-report cross-validates a weak visual signal
- **WHEN** the client's measurement reports `volume: thin` (a signal unreliable on its own) and the user has also self-reported hair loss concern
- **THEN** the combined evidence is sufficient to drive a core recommendation, whereas the visual signal alone would not be

### Requirement: Two-Layer Review of Free User Input
The system SHALL review any free-text style input in two layers before it can influence image generation: first a deterministic vocabulary match determining whether the input is within the hairstyle/outfit domain at all, then an LLM review determining whether it crosses product boundaries.

#### Scenario: Out-of-domain input rejected deterministically
- **WHEN** a user's free input does not match the curated domain vocabulary (e.g. it is unrelated to appearance)
- **THEN** the deterministic first layer rejects it without spending an LLM call

#### Scenario: Boundary-crossing request blocked
- **WHEN** a user's free input requests a change to facial bone structure, feature proportions, gender, age, race, becoming a specific real person, or body-part enhancement
- **THEN** the request is blocked by hard-coded rules independent of model judgment, and no generation is attempted

#### Scenario: In-catalog preference uses reviewed copy
- **WHEN** a user's free input normalizes to a known `style_tag`
- **THEN** generation uses that catalog entry's pre-authored, reviewed `change_description` rather than the user's raw text

#### Scenario: Out-of-catalog but permissible preference is labeled
- **WHEN** a user's free input passes both review layers but does not normalize to any known `style_tag`
- **THEN** generation may proceed from the user's own description, and the result SHALL be presented with an explicit label stating it is the user's specified direction and not from the recommendation library

### Requirement: Client-Side Geometric Measurement Is Authoritative for Face Shape
The system SHALL treat the client-computed `FaceMetrics` (geometry, face-shape classification with confidence and supporting ratios, and photo quality assessment) as the authoritative source for geometric attributes, and SHALL NOT derive face shape from a cloud vision model.

#### Scenario: Face shape comes from measurement, not the vision model
- **WHEN** the pipeline needs the user's face shape to filter style candidates
- **THEN** it reads the classification from the uploaded `face_metrics` payload, and the cloud vision provider is used only for semantic attributes (current hairstyle, facial hair, glasses, skin tone, current outfit)

#### Scenario: Measurement is normalized against capture conditions
- **WHEN** two photos of the same person are taken at different distances or resolutions
- **THEN** the reported geometry is equivalent, because all lengths are normalized to inter-pupillary distance

### Requirement: User Confirmation of Face Shape
The system SHALL present the computed face-shape classification to the user for confirmation or correction before it is used as a hard filter, including the supporting ratio that produced it.

#### Scenario: User confirms the measured classification
- **WHEN** the system reports a face-shape classification with its supporting ratio
- **THEN** the user can confirm it, and the confirmed value is used for candidate filtering

#### Scenario: User corrects the measured classification
- **WHEN** the user disagrees with the computed classification and selects a different one
- **THEN** the user's correction takes precedence over the computed value for all downstream filtering

### Requirement: Full-Body Photo Is Optional and Unlocks Outfit Previews
The system SHALL require a front-facing photo, SHALL treat a full-body photo as optional, and SHALL NOT block intake on the absence of a full-body photo.

#### Scenario: Intake completes without a full-body photo
- **WHEN** a user uploads only a front-facing photo
- **THEN** intake completes successfully and the flow proceeds, with outfit previews degraded rather than the flow blocked

#### Scenario: Missing full-body photo is framed as an unlock, not a gate
- **WHEN** a user without a full-body photo reaches the outfit step
- **THEN** the system presents text outfit plans plus clearly-labeled non-personal reference imagery, and offers uploading a full-body photo as the way to see the effect on themselves
