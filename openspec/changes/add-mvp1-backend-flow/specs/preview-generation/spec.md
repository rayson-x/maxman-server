## ADDED Requirements

### Requirement: Image Generation Is a Globally Serialized Resource
The system SHALL enforce a concurrency limit of one in-flight image-generation task at a time across the whole deployment, covering the full submit-and-poll lifecycle rather than only spacing individual HTTP requests.

#### Scenario: Concurrent generation requests are serialized, not rejected
- **WHEN** multiple generation requests arrive while one task is already in flight
- **THEN** they queue and execute one at a time, so the provider never returns a concurrency-limit error to the user

#### Scenario: Multiple worker processes still respect the global limit
- **WHEN** the deployment runs more than one worker process
- **THEN** concurrency is coordinated across processes (Redis-backed queue limiter), not merely within each process

### Requirement: Progressive Delivery of Preview Results
The system SHALL return text recommendations as soon as they are ready and SHALL deliver each generated preview image as it completes, rather than withholding all results until the full set is done.

#### Scenario: Text arrives before any image
- **WHEN** the recommendation step completes but no image has been generated yet
- **THEN** the client can already read the recommended candidates with their scores and rationales

#### Scenario: Images arrive one at a time
- **WHEN** the first preview image completes while later ones are still queued
- **THEN** it becomes visible to the client immediately, and each subsequent image appears as it completes

#### Scenario: Submission order puts the best candidate first
- **WHEN** multiple previews are queued for generation
- **THEN** they are submitted in descending match-score order, so that under single-task concurrency the first image the user sees is the top recommendation

### Requirement: Preview Count Is Bounded by Capacity
The system SHALL bound the number of preview images generated per user per selection step, recognizing that each image consumes shared global serial capacity.

#### Scenario: Hairstyle step generates a bounded set
- **WHEN** hairstyle previews are generated
- **THEN** at most three are produced, selected as the highest-match candidates

#### Scenario: Outfit step generates a bounded set
- **WHEN** outfit previews are generated for a user with a full-body photo
- **THEN** at most three are produced

#### Scenario: Users without a full-body photo consume no outfit generation capacity
- **WHEN** a user has no full-body photo
- **THEN** no outfit preview images are generated for them, and the outfit step consumes no generation capacity

### Requirement: Categorical Outfit Rendering Without Garment Images
The system SHALL render outfit previews from categorical text descriptions applied to the user's full-body photo, and SHALL NOT require a concrete garment image for preview purposes.

#### Scenario: Outfit preview needs no garment photo
- **WHEN** an outfit preview is generated for a candidate described categorically (e.g. a fitted navy shirt with beige straight-leg trousers)
- **THEN** it is produced by instruction-based image editing on the user's photo, with no garment image supplied

#### Scenario: Outfit copy describes a category, not a specific purchasable item
- **WHEN** an outfit recommendation is presented
- **THEN** its executability is carried by the category description, and any accompanying imagery is presented as illustrative of that category rather than as a specific item to buy

### Requirement: Single Retry Then Graceful Degradation
The system SHALL retry a failed generation exactly once and, if it fails again, SHALL deliver the successful subset while explicitly disclosing what could not be generated.

#### Scenario: Partial set is usable
- **WHEN** two of three preview images succeed and the third fails after its retry
- **THEN** the user can proceed to select from the two available candidates

#### Scenario: Missing candidate is disclosed, not silently dropped
- **WHEN** a candidate's preview could not be generated
- **THEN** the response explicitly states that a candidate is missing and offers a retry, rather than presenting the reduced set as if it were complete

### Requirement: Identity Preservation Constraints on Every Generation
The system SHALL constrain every generation to preserve facial structure, face shape, and body proportions, and SHALL NOT generate a body for a user from a face-only photo.

#### Scenario: No body is invented from a headshot
- **WHEN** a user has provided only a front-facing photo
- **THEN** the system does not generate a full-body image of them, because identity preservation degrades unacceptably when body descriptors drive the generation

#### Scenario: Body data informs recommendations, not generation
- **WHEN** the user's height, weight, BMI, body-fat, exercise habit, or detailed measurements are available
- **THEN** they are used to select which outfit candidates to recommend, and are not passed as body descriptors to the image generator
