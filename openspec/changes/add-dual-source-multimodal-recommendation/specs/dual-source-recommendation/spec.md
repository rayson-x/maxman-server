## ADDED Requirements

### Requirement: Domain Recommendation Tools Share One Dual-Source Engine

The system SHALL expose `recommend-style-directions`, `recommend-hairstyles`, and
`recommend-wardrobe` as the only public recommendation tools for their domains. Fixed workflows and
conversation Agents SHALL call these tools through one shared dual-source application engine and SHALL
NOT call channel A, channel B, diff, reviewer, or catalog providers directly.

#### Scenario: Workflow and Agent request the same wardrobe recommendation

- **WHEN** a fixed workflow and a conversation Agent submit the same authorized versioned input to `recommend-wardrobe`
- **THEN** both use the same engine, contracts, idempotency, diff, merge, persistence, and degradation behavior

#### Scenario: Agent attempts to bypass orchestration

- **WHEN** an Agent needs a recommendation
- **THEN** no A/B, diff, reviewer, or raw catalog-provider tool is available for it to call

### Requirement: Recommendation Proceeds Through Three User Selection Stages

The system SHALL recommend and wait for selection in this order: style direction, hairstyle, then
wardrobe. Hairstyle recommendation SHALL require the selected style, and wardrobe recommendation
SHALL require both the selected style and selected hairstyle.

#### Scenario: User completes the full recommendation path

- **WHEN** the user selects a style direction and then a hairstyle
- **THEN** each downstream recommendation includes the persisted upstream selections and the system next offers wardrobe formulas

#### Scenario: Upstream selection changes

- **WHEN** the user changes a selected style or hairstyle
- **THEN** the system preserves prior history, invalidates affected downstream computation keys, and creates a new downstream generation

### Requirement: Baseline and System-Guided Channels Are Comparable

For each domain, the system SHALL run channel A and channel B in parallel using the same multimodal
user input, provider, model, model version, base prompt, schema, temperature, and token limit. Channel A
SHALL receive no system catalog, rule, catalog-size, or recall-summary information. Channel B SHALL
receive the same user input plus applicable system context. The system SHALL use the same seed when
supported and otherwise SHALL record that the comparison is stochastic.

#### Scenario: Both channels are submitted

- **WHEN** a domain recommendation starts
- **THEN** A and B are submitted concurrently with identical user and model settings, and only B receives system context

#### Scenario: Provider does not support a seed

- **WHEN** the selected provider cannot fix a seed
- **THEN** the comparison log records `stochasticComparison=true` and does not represent the diff as purely caused by system context

### Requirement: Recommendation Uses Original Multimodal Evidence

The system SHALL use original authorized user photos and versioned structured profile/analysis data.
It SHALL NOT use generated previews or target images as recommendation input. Style and wardrobe SHALL
receive the front photo and, when available, a full-body photo; hairstyle SHALL receive the front photo
and MAY receive an originally uploaded side photo when that input is supported.

#### Scenario: Generated preview exists

- **WHEN** a hairstyle or outfit preview already exists before a later recommendation
- **THEN** that generated asset is excluded from both A and B inputs

#### Scenario: Full-body photo is absent

- **WHEN** wardrobe recommendation starts without a full-body photo
- **THEN** both channels use recorded measurements and self-reported body data, mark visual body evidence missing, make no claim of observing body proportions, and do not offer a personalized outfit-swap preview

### Requirement: System Recall Is Complete and Bounded by Deterministic Batching

Channel B SHALL recall every applicable system candidate and rule without a business Top-K limit.
It SHALL project them into a compact structured form. If all applicable projected data does not fit one
model context, the system SHALL split it by stable ID, run every batch, and deterministically merge the
batch outputs without silent truncation.

#### Scenario: Applicable data fits one context

- **WHEN** the compact applicable context fits the configured model budget
- **THEN** `retrievedCount` equals `submittedCount`, `batchCount` is one, and no unrelated research text is submitted

#### Scenario: Applicable data exceeds one context

- **WHEN** the compact applicable context exceeds the configured model budget
- **THEN** all candidates are assigned to stable deterministic batches, every batch is processed, results are merged by a versioned policy, and the log records counts, bytes, and tokens

### Requirement: Both Channels Return Strict Domain-Normalized Candidates

Both channels SHALL return the same versioned schema for the requested domain. Channel A MAY create
stable concept IDs for catalog-external candidates. Channel B SHALL reference only recalled IDs and
SHALL attach each applied rule's ID, mechanism, S1/S2/S3 evidence level, applicability conditions, and
evaluated applicability result.

#### Scenario: B returns an unknown catalog ID

- **WHEN** a B candidate or slot references an ID not present in its recalled batch set
- **THEN** the candidate is rejected from the normalized B result and the schema violation is recorded

#### Scenario: A proposes a catalog-external item

- **WHEN** A proposes a valid domain candidate that has no current catalog mapping
- **THEN** the system assigns or reuses a stable concept ID and retains the structured candidate for diff and possible exploration

### Requirement: Diff and User Result Assembly Are Deterministic

The system SHALL use versioned domain canonicalizers, diff policies, and thresholds to produce
`diffScore`, `severity`, `dimensions`, `hardConflict`, and `diffPolicyVersion`. It SHALL assemble user
results in this order: A/B consensus, correctly applicable B-only system-supported candidates, then at
most one A-only exploration candidate that passes deterministic hard-conflict policy. It SHALL NOT use
an LLM debate or synchronous LLM arbitration.

#### Scenario: Channels disagree without a hard conflict

- **WHEN** A has one valid candidate absent from B and the candidate passes hard-conflict policy
- **THEN** the main result contains consensus and system-supported candidates first and MAY contain that candidate as the sole exploration result

#### Scenario: Strict intersection is empty

- **WHEN** A and B have no canonical candidate in common
- **THEN** the system does not return an empty result solely because the intersection is empty and instead applies the fixed B-supported and exploration policies

#### Scenario: Result counts are assembled

- **WHEN** a recommendation succeeds
- **THEN** style and hairstyle each contain three main candidates plus no more than one exploration candidate, while wardrobe contains one main formula, two alternatives, and no more than one exploration formula, without placeholder exploration entries

### Requirement: Explicit User Style Remains in Downstream Recommendation

The system SHALL preserve a valid user-selected style in hairstyle and wardrobe recommendation context
and output. Other styles MAY be offered as alternatives but SHALL NOT replace or suppress the explicit
selection.

#### Scenario: System ranks another style higher

- **WHEN** the user selected a supported style and B ranks a different style higher
- **THEN** downstream results still include an adaptation of the user's selected style and clearly separate any alternative

### Requirement: Channel and Catalog Failures Degrade Predictably

Each channel SHALL have its own configurable timeout and persisted outcome. If A fails, the system SHALL
return B plus deterministic system results. If B fails, it SHALL return deterministic system results and
MAY add at most one safe A exploration. If both fail, it SHALL return deterministic system results. If
the system catalog is unavailable, any returned A candidates SHALL be labeled AI exploration and SHALL
NOT be labeled system-verified.

#### Scenario: Only one channel times out

- **WHEN** one channel exceeds its timeout and the other succeeds
- **THEN** the response follows the defined single-channel degradation path and the successful channel is not retried

#### Scenario: Both channels fail

- **WHEN** A and B both fail but deterministic system data is available
- **THEN** the user receives the deterministic system result and the comparison log records both failures

### Requirement: Comparison, Exposure, Choice, and Outcome Are Persisted

The system SHALL persist a structured comparison record containing domain and ownership references,
complete versioned profile/photo/analysis/questionnaire/context references, A/B outputs and rationales,
provider/model/prompt/schema/catalog/rule/retrieval/diff/merge versions, applied-rule evidence, call
outcomes, user-exposed candidate source and position, costs, latency, retry, reuse, reviewer state, and
timestamps. Exposure, choice, and strong outcome events SHALL be separate layers.

#### Scenario: Recommendation is returned to the user

- **WHEN** the assembled candidates are exposed
- **THEN** the exact candidate IDs, internal source provenance, positions, comparison generation, and exposure timestamp are persisted before or atomically with the user-visible response

#### Scenario: User later selects a candidate

- **WHEN** the user selects an exposed candidate
- **THEN** the choice references the comparison and exposure while remaining classified as behavioral evidence rather than objective correctness

#### Scenario: Adoption is analyzed

- **WHEN** A- and B-origin candidate adoption rates are compared
- **THEN** the denominator includes only actual exposures and retains display position, while views and scrolling are excluded as preference signals

### Requirement: High-Diff Reviewer Is Asynchronous and Non-Authoritative

Low-diff comparisons SHALL have reviewer status `not_required`. High-diff comparisons SHALL enqueue one
idempotent asynchronous reviewer after the user result is available. Reviewer completion SHALL NOT
alter that result and SHALL produce only a structured classification and notes.

#### Scenario: High-diff result is returned

- **WHEN** deterministic diff severity is high
- **THEN** the user receives the assembled result without waiting for reviewer and the comparison transitions to reviewer `pending`

#### Scenario: Reviewer completes

- **WHEN** reviewer processes the comparison
- **THEN** it records `agree`, `rule_gap`, `rule_conflict`, `rule_misapplied`, or `llm_hallucination` with relevant rule IDs and notes, without storing a debate transcript or rewriting candidates

### Requirement: Catalog-External Concepts Produce Trackable Gaps

A catalog-external exploration candidate SHALL have a stable concept ID. Missing catalog mappings or
assets SHALL be represented explicitly and SHALL create or update a catalog gap and asset generation
task. A user MAY select the structured text concept, but personalized try-on SHALL remain unavailable
until required assets exist.

#### Scenario: Exploration wardrobe slot has no mapped item

- **WHEN** an exposed exploration formula contains an unmapped slot
- **THEN** the slot returns `catalogStatus=not_mapped`, `assetStatus=missing`, and `generationStatus=queued`, and a deduplicated gap/task is persisted

#### Scenario: Concept is mapped later

- **WHEN** staff maps a concept ID to a reviewed catalog item and assets
- **THEN** future resolution can use the mapping, while the historical recommendation remains an immutable record of the concept and asset status at exposure time

### Requirement: Recommendation Computation Is Idempotent Per Channel

The system SHALL calculate versioned computation keys per stage, domain, and channel from user snapshot
versions, asset versions, selected upstream candidates, generation, and catalog/rule/prompt/model/schema/
diff/merge versions. Duplicate requests SHALL reuse completed channel results and retry only failed
channels. Only explicit refresh, relevant input changes, upstream selection changes, or version changes
SHALL create a new generation.

#### Scenario: B succeeded and A failed

- **WHEN** the same recommendation is resumed
- **THEN** the system reuses B and retries only A under the same comparison generation

#### Scenario: User explicitly refreshes

- **WHEN** the user requests a new batch
- **THEN** a new generation is created while the prior exposed recommendation and choices remain immutable

### Requirement: Identifiable Comparison Data Follows Consent and Deletion

While the account and consent remain active, the system SHALL retain versioned references needed to
explain the recommendation. On account deletion or face-processing consent withdrawal, it SHALL delete
photos, face analyses, identifiable profile snapshots, comparison ownership links, and combinations of
attributes that could re-identify the user. It MAY retain only irreversible anonymous aggregates.
Ordinary service logs SHALL contain IDs, timing, and error codes only and SHALL NOT contain photos,
signed URLs, raw prompts, raw recommendation payloads, or model transcripts.

#### Scenario: User withdraws face-processing consent

- **WHEN** the withdrawal deletion job completes
- **THEN** no comparison record can resolve the user's photo, face analysis, or identifiable appearance profile

#### Scenario: Anonymous aggregate is retained

- **WHEN** aggregate counts remain after deletion
- **THEN** they contain no reversible user reference or rare attribute combination capable of reconstructing the deleted profile

