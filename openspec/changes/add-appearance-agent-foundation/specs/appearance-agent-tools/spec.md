## ADDED Requirements

### Requirement: Vendor-Agnostic Provider Injection
The system SHALL construct every tool with its backing provider passed as an explicit argument rather than the tool looking up a global registry. Only the composition root SHALL read `ACTIVE_*_PROVIDER` environment variables to select a concrete vendor implementation.

#### Scenario: Tool has no knowledge of vendor selection
- **WHEN** a tool factory (e.g. `createAnalyzeAppearancePhotoTool`) is invoked
- **THEN** it receives a fully-constructed provider instance as its only argument and contains no reference to environment variables or a provider registry

#### Scenario: Switching vendors requires no tool/agent code changes
- **WHEN** `ACTIVE_VISION_PROVIDER` is changed from `zhipu` to `qwen` in the environment
- **THEN** the composition root constructs a different concrete `VisionAnalysisProvider` and injects it into the same unchanged tool factory

### Requirement: Vision Analysis Tool
The system SHALL provide an `analyze-appearance-photo` tool that returns a structured textual description of a user's photo without the reasoning model itself needing multimodal capability.

#### Scenario: Agent requests analysis before recommending changes
- **WHEN** the agent needs to reason about a user's appearance and has not yet analyzed their photo in the current conversation
- **THEN** it calls `analyze-appearance-photo` with the photo URL and a focus area, and receives back a structured text/JSON description rather than the raw image

### Requirement: Baseline-Photo-Only Image Editing
The system SHALL provide an `edit-appearance-image` tool that edits ONLY the user's original baseline photo, never a previously generated image, to prevent identity drift across successive edits.

#### Scenario: Agent edits the original photo
- **WHEN** the agent calls `edit-appearance-image`
- **THEN** the tool passes the given `baselineImageUrl` directly to the image-edit provider, and the returned result includes a `callId` for later billing/recovery reference

#### Scenario: Prior generated image is not reused as input
- **WHEN** the agent has previously generated a target image in the conversation and now needs a further edit
- **THEN** the agent's instructions require it to call `edit-appearance-image` again with the ORIGINAL baseline photo URL, not the previously generated image's URL

### Requirement: Outfit Swap Tool
The system SHALL provide a `swap-outfit` tool distinct from `edit-appearance-image`, taking a person photo and a separate garment photo, backed by a specialized garment-fitting provider rather than generic instruction-based img2img.

#### Scenario: Agent generates a full-body outfit target image
- **WHEN** the agent has a person photo and a garment photo
- **THEN** it calls `swap-outfit` with both URLs and receives a result image plus a `callId`

### Requirement: Illustrative Reference Image Tool Never Presented as Personalized
The system SHALL provide a `generate-reference-image` tool for pure text-to-image illustration with no input photo and no identity preservation, and the agent SHALL always disclose to the user that its output is not a personalized result.

#### Scenario: User asks to see a style concept without uploading a photo
- **WHEN** a user asks what a hairstyle or garment style looks like without providing their own photo
- **THEN** the agent calls `generate-reference-image` and explicitly tells the user the result is a generic illustration, not their own personalized effect

#### Scenario: Agent does not substitute this tool for personalized generation
- **WHEN** the agent has the user's baseline photo available
- **THEN** it uses `edit-appearance-image` or `swap-outfit` instead of `generate-reference-image` for anything presented as the user's own result

### Requirement: Catalog-Constrained Direction Recommendation
The system SHALL provide a `recommend-appearance-directions` tool that scores ONLY entries from a human-curated `CandidateTaskCatalog` filtered to `isRecommended=true`, and SHALL NOT allow the underlying model to invent methods outside that catalog or compute a final priority ranking.

#### Scenario: Excluded catalog entries are never surfaced
- **WHEN** `recommend-appearance-directions` is called for a domain that has a catalog entry marked `isRecommended=false`
- **THEN** that entry is filtered out before the candidate list is ever sent to the model, and it cannot appear in the tool's output

#### Scenario: Tool output is raw scores, not a ranking
- **WHEN** `recommend-appearance-directions` returns results
- **THEN** each candidate has independent 0-10 scores across visual benefit, credibility, acceptance, reversibility, time cost, money cost, and risk, with no combined/final rank field, and the agent's instructions forbid it from computing one itself

#### Scenario: Model-hallucinated candidate ids are dropped
- **WHEN** the underlying model's response references a `catalogEntryId` not present in the candidates that were sent to it
- **THEN** the provider filters out that score entry before returning results

### Requirement: Unconstrained Suggestions Are Never Shown Unvetted
The system SHALL provide a `suggest-unconstrained-directions` tool whose output is explicitly unvetted, and the agent SHALL NOT present any of its suggestions to the user without first passing them through `adversarial-review-recommendations`.

#### Scenario: Agent seeks bolder suggestions on user request
- **WHEN** a user explicitly asks for more ambitious suggestions beyond the conservative catalog
- **THEN** the agent calls `suggest-unconstrained-directions`, and its instructions require calling `adversarial-review-recommendations` immediately afterward before saying anything about these suggestions to the user

### Requirement: Adversarial Review Gates What Reaches the User
The system SHALL provide an `adversarial-review-recommendations` tool that judges each unconstrained suggestion against the catalog-constrained candidates, defaulting to skepticism, and the agent SHALL only present suggestions with an `accept` verdict.

#### Scenario: Rejected suggestion is disclosed, not hidden
- **WHEN** a free suggestion receives a `reject` verdict
- **THEN** the agent explains to the user that the suggestion was considered and rejected, along with the reason, rather than silently omitting it

#### Scenario: Suggestion needing professional review is redirected
- **WHEN** a free suggestion receives a `needs_professional_review` verdict
- **THEN** the agent recommends the user consult a relevant professional rather than presenting the suggestion as a self-service action

#### Scenario: Accepted suggestion is presented alongside catalog baseline
- **WHEN** one or more free suggestions receive an `accept` verdict
- **THEN** the agent presents them to the user clearly distinguished from the catalog-constrained baseline recommendations, along with the overall feasibility and improvement-rate scores

### Requirement: Volcengine Call Rate Limiting
The system SHALL serialize all calls to Volcengine's Visual/CV OpenAPI through a shared rate limiter enforcing a minimum interval between call starts, to stay under the vendor's ~2 QPS cap.

#### Scenario: Concurrent tool calls do not exceed the vendor's rate cap
- **WHEN** multiple Volcengine-backed tool calls (submit or poll) are in flight concurrently within the same process
- **THEN** their underlying HTTP requests are spaced at least the configured minimum interval apart, regardless of call order or originating tool

### Requirement: Durable Async Call Ledger
The system SHALL durably record every Volcengine async task under its `task_id` before returning control to the caller, and SHALL support resuming a poll loop from just that id after a process restart.

#### Scenario: Call is recorded even if the caller never polls to completion
- **WHEN** a Volcengine task is submitted successfully
- **THEN** its `task_id`, provider, `req_key`, and a redacted request summary are persisted before the submit call returns, independent of whether polling ever completes

#### Scenario: Resuming after a crash does not resubmit
- **WHEN** a caller has only a previously-recorded `callId` (e.g. after a process restart) and calls `resumeVolcVisualTask`
- **THEN** the system looks up the original `req_key` from the ledger and resumes polling the existing task rather than submitting a new one
