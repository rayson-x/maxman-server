## ADDED Requirements

### Requirement: Anonymous Device Session Identity via Explicit Endpoint
The system SHALL identify users via an anonymous `device_session_id` instead of requiring phone-based login in MVP1. The client SHALL explicitly call `POST /auth/device-session` (typically on first app load) to obtain this session rather than relying on implicit middleware-only issuance; the endpoint SHALL be idempotent so calling it when a valid session already exists simply returns the existing session rather than creating a new one. The server SHALL persist the id in a long-lived cookie, and the client SHALL additionally store it in `localStorage` as a fallback.

#### Scenario: First-time visitor requests a session
- **WHEN** a client with no existing session cookie calls `POST /auth/device-session`
- **THEN** the server issues a new `device_session_id`, creates a corresponding `User` record with `phone` left null, sets a long-lived cookie containing the session id, and returns the id in the response body

#### Scenario: Calling the endpoint again is idempotent
- **WHEN** a client with an existing valid `device_session_id` cookie calls `POST /auth/device-session` again
- **THEN** the server returns the same existing session id and does not create a new `User` record

#### Scenario: Returning visitor is recognized on subsequent requests
- **WHEN** a browser with an existing valid `device_session_id` cookie makes any other request to the app
- **THEN** the server associates the request with the existing `User` record without requiring another call to `POST /auth/device-session`

#### Scenario: Cookie lost but localStorage retains id
- **WHEN** the cookie is missing but the client has a `device_session_id` in `localStorage`
- **THEN** the client resends the stored id to the server, and the server re-associates the session if the id is still valid

### Requirement: No Authentication Enforcement in MVP1
The system SHALL NOT require JWT tokens, phone verification, or any authentication challenge for API access in MVP1. All endpoints SHALL rely solely on the `device_session_id` for user association.

#### Scenario: API call without phone verification
- **WHEN** a client with a valid `device_session_id` calls any plan/questionnaire/photo endpoint
- **THEN** the server processes the request without checking phone verification status or issuing/validating JWT tokens
