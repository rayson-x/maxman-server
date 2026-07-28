# contextual-outfit-recommendation Specification

## Purpose
TBD - created by archiving change add-seasonal-outfit-context. Update Purpose after archive.
## Requirements
### Requirement: Province and City Resolve One Canonical Weather Location
The system SHALL accept bounded client-supplied province and city strings, SHALL resolve them to one canonical weather location and IANA time zone through the weather provider, and SHALL reject ambiguous or province-mismatched results.

#### Scenario: Province and city match one result
- **WHEN** normalized province and city identify one provider location
- **THEN** the service returns its canonical name, coarse coordinates, provider location identifier, and IANA time zone

#### Scenario: City name is ambiguous
- **WHEN** the provider returns multiple city matches and province does not identify exactly one
- **THEN** the service returns a typed location error and does not fetch or fabricate weather

#### Scenario: Client submits unsupported location fields
- **WHEN** input includes GPS coordinates, IP address, or photo-derived location
- **THEN** those fields are rejected or excluded from the documented city-input contract

### Requirement: Rolling Three-Year History Is Stored as Validated Local JSON
The system SHALL fetch daily minimum, mean, and maximum Celsius temperatures for the rolling previous 36 months and SHALL store them in one schema-versioned local JSON file keyed safely by normalized province/city.

#### Scenario: Valid current history file exists
- **WHEN** the local JSON validates, covers the requested period, and is within refresh age
- **THEN** it is reused without a historical API call

#### Scenario: File is missing, stale, incomplete, or corrupt
- **WHEN** no reusable local JSON exists
- **THEN** the service fetches validated history and atomically replaces the cache file

#### Scenario: Location contains filesystem metacharacters
- **WHEN** province or city text contains path separators or traversal tokens
- **THEN** the deterministic hashed cache key prevents it from controlling the filesystem path

#### Scenario: Agent context is built
- **WHEN** valid daily history is available
- **THEN** it is summarized to at most 12 monthly temperature rows and raw daily rows are not placed in the prompt

### Requirement: Current and Future Temperature Are Fetched at Agent Startup
The system SHALL fetch current temperature, apparent temperature, and daily minimum/maximum temperature for the configured 7–15-day horizon through the weather API before starting the corresponding Agent run.

#### Scenario: Live weather succeeds
- **WHEN** the provider returns valid bounded values and timestamps
- **THEN** the Agent weather context marks the live block fresh and includes only the business fields

#### Scenario: Live weather fails
- **WHEN** the call times out, returns a non-success status, is oversized, or fails schema validation
- **THEN** the live block is explicitly unavailable and the Agent is instructed not to claim current or forecast weather

### Requirement: Historical and Live Temperature Are Injected as Structured System Context
The system SHALL build one bounded `AgentWeatherContext` from server time, resolved city/time zone, monthly historical summaries, and live/forecast temperature, and SHALL inject it into the system instructions for that Agent run.

#### Scenario: Both data blocks are available
- **WHEN** the Agent run starts with valid historical and live data
- **THEN** its dynamic system instructions contain both labeled JSON blocks, tell it which block applies to long-term versus immediate suggestions, and retain existing safety/catalog instructions

#### Scenario: One data block is unavailable
- **WHEN** history or live weather is unavailable
- **THEN** the missing block is represented explicitly and the system instructions prohibit fabricating it

#### Scenario: Location text resembles a prompt instruction
- **WHEN** province or city contains instruction-like text
- **THEN** it is serialized only as JSON data within fixed delimiters and cannot replace the fixed system instructions

#### Scenario: Agent is shared across requests
- **WHEN** consecutive users start Agent runs for different cities
- **THEN** each run receives only its own dynamic weather context and global/singleton instructions are not mutated

