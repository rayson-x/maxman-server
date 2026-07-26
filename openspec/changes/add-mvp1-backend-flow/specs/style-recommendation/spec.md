## ADDED Requirements

### Requirement: Style Coherence Is Enforced by Deterministic Computation, Never by Model Judgment
The system SHALL determine whether a hairstyle and an outfit are stylistically compatible by comparing their style vectors deterministically, and SHALL NOT ask a language model to judge whether two items go together. The language model's role SHALL be limited to selecting from and writing copy about an already-compatible candidate set.

#### Scenario: Incompatible pairing is filtered before the model sees it
- **WHEN** a hairstyle and an outfit differ by more than the configured threshold on any style-vector dimension
- **THEN** that combination is excluded from the candidate set by deterministic computation, and the language model never has the opportunity to propose it

#### Scenario: Model selects only within the compatible set
- **WHEN** the language model is asked to pick the best candidates for a user
- **THEN** its input is the already-filtered compatible combination set, and any output referencing an item outside that set is discarded

### Requirement: Style Vector Encoding With O(1) Annotation Cost
The system SHALL encode style compatibility as per-item vectors across the dimensions formality, maturity, boldness, and upkeep (each 1-10), rather than as a pairwise compatibility matrix.

#### Scenario: Adding a new hairstyle requires no pairwise annotation
- **WHEN** a new hairstyle entry is added to the catalog
- **THEN** it only needs its own dimension scores and applicability conditions, with no need to annotate its relationship to any existing outfit entry

#### Scenario: Compatibility threshold is configurable
- **WHEN** the compatibility threshold needs tuning against real user selection behavior
- **THEN** it is adjustable as server-side configuration without code changes

### Requirement: Hair Signal Combination With Confidence Tiers
The system SHALL apply hairline and hair-volume signals as filters only in the combinations below, and SHALL NOT apply a thin-volume signal on its own.

#### Scenario: Both signals present yields a strong constraint
- **WHEN** the measurement reports a receding or high hairline AND thin volume
- **THEN** the system excludes hairstyles with `requires_hair_volume = high` and prioritizes low-volume-requirement styles

#### Scenario: Hairline signal alone yields a moderate constraint
- **WHEN** the measurement reports a receding or high hairline but volume is not thin
- **THEN** the system excludes hairstyles with `covers_forehead = false` and prioritizes styles with fringe/forward coverage, without applying any volume-based exclusion

#### Scenario: Thin volume alone yields no constraint
- **WHEN** the measurement reports thin volume but the hairline is normal
- **THEN** the system applies no hair-related exclusion, because short hair and low density are indistinguishable in a frontal photo

#### Scenario: Occluded hairline degrades to semantic judgment
- **WHEN** the hairline cannot be measured because it is occluded by a fringe
- **THEN** the system defers the hairline determination to the cloud vision model or to the user's self-report, rather than treating the signal as absent or as normal

#### Scenario: Hair attributes are expressed as styling feasibility, never diagnosis
- **WHEN** a hair-related constraint is communicated to the user
- **THEN** it is phrased in terms of whether a style is achievable with their hair, and never as a detected medical or hair-loss condition

### Requirement: Style Catalog Constraint Attributes
The system SHALL store `requires_hair_volume` (low/medium/high) and `covers_forehead` (boolean) on each `StyleReferenceGuide` entry, and SHALL use them as hard filters driven by `FaceMetrics` with `evidence_basis: visual_detected`.

#### Scenario: Filter attributes drive the rule engine, not the model
- **WHEN** hair signals require excluding certain styles
- **THEN** the exclusion is performed by the rule engine reading these catalog attributes, consistent with the existing division where the model writes copy and the rule engine filters and ranks

### Requirement: Two-Step Constrained Selection — Hairstyle Then Outfit
The system SHALL have the user select a hairstyle first and an outfit second, with the outfit candidate set filtered by the chosen hairstyle. It SHALL NOT present hairstyle and outfit as independent parallel choices.

#### Scenario: Outfit candidates depend on the chosen hairstyle
- **WHEN** a user has selected a hairstyle
- **THEN** the outfit candidates offered are only those compatible with that hairstyle's style vector

#### Scenario: Same hairstyle supports multiple outfits
- **WHEN** a user wants to change their outfit direction later
- **THEN** they can re-select an outfit without re-deciding the hairstyle, since the two are separate sequential decisions rather than one atomic bundle

#### Scenario: Irreversible decision comes first
- **WHEN** the selection flow is ordered
- **THEN** the hairstyle decision (which takes weeks to reverse) precedes the outfit decision (which is freely reversible)

#### Scenario: Guided selections are sequential, never parallel
- **WHEN** a stage contains more than one `guided_selection` task
- **THEN** they form a dependency chain where each one's candidate set is constrained by the previous choice, rather than being offered simultaneously

### Requirement: User Preference Is Rendered Before It Is Judged
The system SHALL, when a user has expressed their own style preference, generate the preview of that preference first and present the system's assessment afterward, alongside the system's own recommendations.

#### Scenario: User's own idea is shown before being assessed
- **WHEN** a user has supplied a permissible style preference
- **THEN** the system generates the preview of the user's preference, then presents its assessment (suitable / unsuitable with reasons / needs professional review), then presents its own recommendations alongside it

#### Scenario: Unsuitable preference is explained, not hidden
- **WHEN** the system assesses the user's preference as unsuitable
- **THEN** it still shows the generated preview and states the specific reasons, rather than refusing to render it

#### Scenario: No preference means no preference branch
- **WHEN** a user expressed no preference
- **THEN** the system performs no preference assessment and incurs none of that branch's cost

### Requirement: Recommendation Output Carries Raw Scores, Not a Final Ranking
The system SHALL have the language model output per-candidate dimension scores and rationales, and SHALL compute any final priority ordering with a fixed server-side weighted formula rather than accepting a model-produced ranking.

#### Scenario: Model does not decide priority
- **WHEN** candidate scoring completes
- **THEN** each candidate carries independent dimension scores with no combined rank field, and the ordering is computed by the server's configurable weighted formula
