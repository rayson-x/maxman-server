## ADDED Requirements

### Requirement: Provider operation usage ledger

The system SHALL durably record each externally invoked provider business operation with provider, operation, model when known, status, measured usage, matched pricing-rule identity, and known or unknown estimated cost.

#### Scenario: Unknown-price model invocation

- **WHEN** an operation completes for a model with no matching current pricing rule
- **THEN** its usage is recorded and its cost is marked unknown rather than zero

### Requirement: Billable-unit pricing

The system SHALL calculate cost from a versioned local rule using the provider's business billing unit rather than HTTP request count.

#### Scenario: Volcengine clothing swap

- **WHEN** `dressing_diffusion` accepts a submission and returns a task ID
- **THEN** the system records one accepted task at the rule's ¥1 CNY unit price
- **AND** subsequent poll requests do not create another accepted task cost

### Requirement: Internal cost aggregation

The system SHALL provide authenticated internal aggregation of provider operation counts, usage and cost for a requested time range, with optional provider, model and operation filters.

#### Scenario: Mixed known and unknown usage

- **WHEN** the range contains both priced and unknown-price operations
- **THEN** the response reports known estimated cost separately from unknown-price usage
