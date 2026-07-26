## ADDED Requirements

### Requirement: Independent Face/Photo Processing Consent
The system SHALL present a dedicated consent panel — separate from the general terms of service — before allowing any photo upload, disclosing what is collected, whether facial features are extracted, third-party model provider involvement, storage region and retention period, training usage (opt-in, default off), and how to revoke/delete. The system SHALL record the consent decision via `POST /photos/consent` with a versioned snapshot of the disclosed text.

#### Scenario: User grants processing consent
- **WHEN** a user agrees to the photo/face processing consent panel
- **THEN** the server creates a `ConsentRecord` with `consent_type=face_processing`, the current text version, and a granted timestamp, and photo upload becomes available

#### Scenario: User declines consent
- **WHEN** a user declines the photo/face processing consent panel
- **THEN** the server does not permit photo upload for this session and the client offers a text-only degraded plan path

#### Scenario: Training consent is independent and opt-in
- **WHEN** a user grants face processing consent but does not separately check the training consent option
- **THEN** no `ConsentRecord` with `consent_type=training` is created, and later photo/analysis calls do not mark data as training-eligible

### Requirement: Photo Upload via Presigned URL
The system SHALL accept front, side, and full-body photos via `POST /photos`, using a presigned direct-to-object-storage upload flow, and register a `UserPhoto` record only after the storage upload completes.

#### Scenario: Successful photo upload
- **WHEN** a client uploads a photo using a presigned URL and the storage callback confirms completion
- **THEN** the server creates a `UserPhoto` record with `moderation_status=pending` and enqueues it to the `moderation` queue

### Requirement: Client-Side Face Landmark Measurement
The system SHALL compute face geometry metrics (temple width, cheekbone width, jaw width, face length, eye distance, etc.) entirely on the client using MediaPipe Face Landmarker (Tasks Vision JS, browser WASM runtime) before or during photo confirmation, without sending the photo to any server for this specific measurement step.

#### Scenario: Real-time capture quality feedback
- **WHEN** a user is capturing or selecting a photo on the upload page
- **THEN** the client runs local face detection and shows quality feedback (single face detected, centered, adequate lighting) before allowing confirmation

#### Scenario: Face metrics submitted alongside photo
- **WHEN** a user confirms a photo after local landmark detection
- **THEN** the client computes a `FaceMetrics` structured object and submits it together with the photo upload request, and the server stores it on `UserPhoto.face_metrics`

#### Scenario: Hairline detection is out of scope
- **WHEN** face metrics are computed
- **THEN** the system does not attempt to detect hairline position, since it is not a standard MediaPipe landmark and is explicitly out of scope for this change
