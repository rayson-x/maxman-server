## ADDED Requirements

### Requirement: Versioned, Independent Consent Records
The system SHALL record every consent decision (general terms, face/photo processing, training usage) as an independent, versioned `ConsentRecord` with a snapshot of the disclosed text, a granted timestamp, and support for a revocation timestamp. The three consent types SHALL be independently revocable without affecting the others.

#### Scenario: Revoking training consent does not affect core usage
- **WHEN** a user revokes their training-usage consent
- **THEN** the system stops marking future photo/analysis calls as training-eligible, but the user can continue using photo analysis and plan features normally

### Requirement: No Training Usage Without Explicit Opt-In
The system SHALL default to NOT using any user photo or derived data for model training. Training usage SHALL only occur when a valid, separate `ConsentRecord` with `consent_type=training` exists for that user at the time of the model call.

#### Scenario: Default analysis call excludes training flag
- **WHEN** a user has granted face-processing consent but not training consent
- **THEN** analysis and generation calls for that user's data do not set any training-usage flag

### Requirement: Granular, Asynchronous Data Deletion
The system SHALL allow deletion at multiple granularities: single original photo, all original photos, single target image, all generated images, derived facial features, complete appearance profile, and entire account. Every deletion request SHALL be processed asynchronously: the API SHALL immediately mark `deletion_status=pending` and return success, while actual object-storage file removal and cross-table cascading cleanup SHALL be performed by a background queue job with retry support.

#### Scenario: Delete-all-photos request returns immediately
- **WHEN** a user requests deletion of all their original photos
- **THEN** the API responds successfully right away with `deletion_status=pending` for each affected `UserPhoto`, and the client is told the deletion will complete within a stated time window rather than being told it is already done

#### Scenario: Background deletion job completes cleanup
- **WHEN** the background deletion queue job for a photo completes
- **THEN** the object storage file, the `UserPhoto` row, related `ChangeManifestEntry` references, and photo references in model-invocation logs (redacted, statistics retained) are all cleaned up

#### Scenario: Account deletion cascades fully
- **WHEN** a user requests full account deletion
- **THEN** the system asynchronously removes all photos, generated images, plan data, consent records (retaining only the minimum legally required audit trail if applicable), and the `User` record itself

### Requirement: AI-Generated Content Labeling
The system SHALL mark every AI-generated `TargetImage` as simulated/AI-generated content in three places: an on-page visible label wherever the image is displayed, a visible watermark on any exported copy, and an AI-generation marker embedded in the exported file's metadata. Sharing or exporting a `TargetImage` SHALL NOT strip this labeling by default.

#### Scenario: Generated image displayed in-app carries a visible label
- **WHEN** a `TargetImage` is rendered on the plan page or any other in-app surface
- **THEN** the response/render includes an explicit "AI-generated simulated effect" label alongside the image, not just in a separate disclaimer paragraph elsewhere on the page

#### Scenario: Exported image retains watermark and metadata marker
- **WHEN** a user saves or shares a `TargetImage` (e.g. via the haircut communication card's "save image" action)
- **THEN** the exported file has a visible watermark and an AI-generation marker written into its file metadata, and no user-facing option removes both by default
