# Database Integration

<cite>
**Referenced Files in This Document**
- [perfect-schema.sql](file://backend/supabase/perfect-schema.sql)
- [schema.sql](file://backend/supabase/schema.sql)
- [database_schema.sql](file://backend/src/database_schema.sql)
- [supabase-client.js](file://backend/src/supabase-client.js)
- [config.js](file://backend/src/config.js)
- [user-service.js](file://backend/src/user-service.js)
- [session.js](file://backend/src/session.js)
- [http-server.js](file://backend/src/http-server.js)
- [index.js](file://backend/src/index.js)
- [fixture-store.js](file://backend/src/fixture-store.js)
- [fixture-catalogs.js](file://backend/src/fixture-catalogs.js)
- [car-defaults.js](file://backend/src/car-defaults.js)
- [team-state.js](file://backend/src/team-state.js)
</cite>

## Table of Contents
1. [Introduction](#introduction)
2. [Project Structure](#project-structure)
3. [Core Components](#core-components)
4. [Architecture Overview](#architecture-overview)
5. [Detailed Component Analysis](#detailed-component-analysis)
6. [Dependency Analysis](#dependency-analysis)
7. [Performance Considerations](#performance-considerations)
8. [Troubleshooting Guide](#troubleshooting-guide)
9. [Conclusion](#conclusion)
10. [Appendices](#appendices)

## Introduction
This document describes the database integration layer built on Supabase and PostgreSQL for the Nitto Legends community server. It covers the database design for player management, session tracking, car ownership, team structures, and messaging. It also documents the Supabase client implementation, connection management, query patterns, data models, entity relationships, and migration strategies. Guidance is included for transitioning from fixture-based responses to database-backed data, along with best practices for validation, security, performance, and extending the schema while maintaining backward compatibility.

## Project Structure
The database integration spans two primary schema definitions and a set of runtime modules:
- Supabase schema scripts define tables, indexes, triggers, and policies.
- Runtime modules implement Supabase client initialization, session management, and data access patterns.
- Fixture-based fallbacks support development and testing without live database connectivity.

```mermaid
graph TB
subgraph "Supabase Schemas"
PERF["perfect-schema.sql"]
SCHEMA["schema.sql"]
DBSCHEMA["database_schema.sql"]
end
subgraph "Runtime Modules"
CFG["config.js"]
CLIENT["supabase-client.js"]
HTTP["http-server.js"]
SESS["session.js"]
USVC["user-service.js"]
IDX["index.js"]
FIXSTORE["fixture-store.js"]
FIXCAT["fixture-catalogs.js"]
CARDEF["car-defaults.js"]
TEAMSTATE["team-state.js"]
end
PERF --> USVC
SCHEMA --> USVC
DBSCHEMA --> USVC
CFG --> CLIENT
CLIENT --> HTTP
CLIENT --> SESS
CLIENT --> USVC
IDX --> HTTP
IDX --> SESS
FIXSTORE --> HTTP
FIXCAT --> HTTP
CARDEF --> USVC
TEAMSTATE --> IDX
```

**Diagram sources**
- [perfect-schema.sql:1-534](file://backend/supabase/perfect-schema.sql#L1-L534)
- [schema.sql:1-325](file://backend/supabase/schema.sql#L1-L325)
- [database_schema.sql:1-306](file://backend/src/database_schema.sql#L1-L306)
- [config.js:42-52](file://backend/src/config.js#L42-L52)
- [supabase-client.js:1-27](file://backend/src/supabase-client.js#L1-L27)
- [http-server.js:253-521](file://backend/src/http-server.js#L253-L521)
- [session.js:1-87](file://backend/src/session.js#L1-L87)
- [user-service.js:1-661](file://backend/src/user-service.js#L1-L661)
- [index.js:1-95](file://backend/src/index.js#L1-L95)
- [fixture-store.js:1-86](file://backend/src/fixture-store.js#L1-L86)
- [fixture-catalogs.js:1-31](file://backend/src/fixture-catalogs.js#L1-L31)
- [car-defaults.js:1-32](file://backend/src/car-defaults.js#L1-L32)
- [team-state.js:1-40](file://backend/src/team-state.js#L1-L40)

**Section sources**
- [perfect-schema.sql:1-534](file://backend/supabase/perfect-schema.sql#L1-L534)
- [schema.sql:1-325](file://backend/supabase/schema.sql#L1-L325)
- [database_schema.sql:1-306](file://backend/src/database_schema.sql#L1-L306)
- [config.js:42-52](file://backend/src/config.js#L42-L52)
- [supabase-client.js:1-27](file://backend/src/supabase-client.js#L1-L27)
- [http-server.js:253-521](file://backend/src/http-server.js#L253-L521)
- [session.js:1-87](file://backend/src/session.js#L1-L87)
- [user-service.js:1-661](file://backend/src/user-service.js#L1-L661)
- [index.js:1-95](file://backend/src/index.js#L1-L95)
- [fixture-store.js:1-86](file://backend/src/fixture-store.js#L1-L86)
- [fixture-catalogs.js:1-31](file://backend/src/fixture-catalogs.js#L1-L31)
- [car-defaults.js:1-32](file://backend/src/car-defaults.js#L1-L32)
- [team-state.js:1-40](file://backend/src/team-state.js#L1-L40)

## Core Components
- Supabase client initialization with service role credentials and disabled client-side session persistence.
- Session management for login, validation, and periodic cleanup.
- Player and car CRUD operations with backward-compatible handling for schema evolution.
- Team and membership queries with ordered retrieval and constraints.
- Fixture-based fallback for development and testing scenarios.

**Section sources**
- [supabase-client.js:1-27](file://backend/src/supabase-client.js#L1-L27)
- [session.js:1-87](file://backend/src/session.js#L1-L87)
- [user-service.js:184-661](file://backend/src/user-service.js#L184-L661)
- [http-server.js:221-251](file://backend/src/http-server.js#L221-L251)
- [fixture-store.js:26-86](file://backend/src/fixture-store.js#L26-L86)

## Architecture Overview
The runtime integrates HTTP requests with Supabase-backed data access. Requests are decrypted, routed, and handled either via database queries or fixture fallbacks. Sessions are validated against the database, and player/car/team data are retrieved and normalized.

```mermaid
sequenceDiagram
participant Client as "Client"
participant HTTP as "http-server.js"
participant Supabase as "Supabase Client"
participant DB as "PostgreSQL"
Client->>HTTP : "POST /gameCode1_00.aspx"
HTTP->>HTTP : "decodeGameCodeQuery()"
HTTP->>Supabase : "handleGameAction(...)"
alt Supabase available
Supabase->>DB : "SELECT/INSERT/UPDATE/DELETE"
DB-->>Supabase : "Rows/Error"
Supabase-->>HTTP : "Result"
else Fixture fallback
HTTP->>HTTP : "fixture-store.find()"
HTTP-->>Client : "Fixture response"
end
HTTP-->>Client : "Encrypted response"
```

**Diagram sources**
- [http-server.js:426-521](file://backend/src/http-server.js#L426-L521)
- [fixture-store.js:75-86](file://backend/src/fixture-store.js#L75-L86)
- [supabase-client.js:1-27](file://backend/src/supabase-client.js#L1-L27)

**Section sources**
- [http-server.js:426-521](file://backend/src/http-server.js#L426-L521)
- [fixture-store.js:26-86](file://backend/src/fixture-store.js#L26-L86)
- [supabase-client.js:1-27](file://backend/src/supabase-client.js#L1-L27)

## Detailed Component Analysis

### Database Design and Entity Model
The database model centers on five core tables with supporting indexes, triggers, and policies. The design emphasizes referential integrity, performance indexing, and optional Row Level Security (RLS) for service roles.

```mermaid
erDiagram
GAME_PLAYERS {
bigint id PK
text username UK
text password_hash
bigint money
bigint points
bigint score
integer image_id
text gender
text driver_text
integer active
integer vip
integer facebook_connected
integer alert_flag
integer blackcard_progress
integer sponsor_rating
integer respect_level
integer message_badge
integer client_role
jsonb badges_json
integer location_id
integer background_id
integer title_id
integer track_rank
bigint default_car_game_id
timestamptz created_at
timestamptz updated_at
}
GAME_SESSIONS {
text session_key PK
bigint player_id FK
timestamptz created_at
timestamptz last_seen_at
timestamptz expires_at
}
GAME_CARS {
bigint game_car_id PK
bigint player_id FK
integer catalog_car_id
boolean selected
integer paint_index
text color_code
text plate_name
integer locked
integer aero
integer image_index
text wheel_xml
text parts_xml
timestamptz created_at
timestamptz updated_at
}
GAME_TEAMS {
bigint id PK
text name UK
text tag
text description
bigint owner_player_id FK
text avatar_path
integer location_id
bigint score
integer wins
integer losses
integer member_count
timestamptz created_at
timestamptz updated_at
}
GAME_TEAM_MEMBERS {
bigint id PK
bigint team_id FK
bigint player_id FK
text role
bigint contribution_score
timestamptz joined_at
timestamptz created_at
timestamptz updated_at
}
GAME_MAIL {
bigint id PK
bigint recipient_player_id FK
bigint sender_player_id FK
text folder
text message_type
text subject
text body
boolean is_read
boolean is_deleted
bigint attachment_money
bigint attachment_points
timestamptz created_at
timestamptz read_at
}
GAME_PLAYERS ||--o{ GAME_CARS : "owns"
GAME_PLAYERS ||--o{ GAME_TEAM_MEMBERS : "belongs_to"
GAME_TEAMS ||--o{ GAME_TEAM_MEMBERS : "has"
GAME_PLAYERS ||--o{ GAME_SESSIONS : "has"
GAME_PLAYERS ||--o{ GAME_MAIL : "receives"
GAME_PLAYERS ||--o{ GAME_MAIL : "sends"
```

**Diagram sources**
- [perfect-schema.sql:16-196](file://backend/supabase/perfect-schema.sql#L16-L196)
- [schema.sql:1-98](file://backend/supabase/schema.sql#L1-L98)

**Section sources**
- [perfect-schema.sql:16-196](file://backend/supabase/perfect-schema.sql#L16-L196)
- [schema.sql:1-98](file://backend/supabase/schema.sql#L1-L98)

### Supabase Client Implementation and Connection Management
- Initializes the Supabase client using environment-provided URL and service role key.
- Disables client-side session persistence and token refresh for backend-only operation.
- Gracefully falls back to fixture-only mode when credentials are missing.

```mermaid
flowchart TD
Start(["createGameSupabase(config, logger)"]) --> CheckCreds["Check supabaseUrl and service role key"]
CheckCreds --> HasCreds{"Credentials present?"}
HasCreds --> |No| Warn["Log warning and return null"]
HasCreds --> |Yes| ImportClient["Dynamic import '@supabase/supabase-js'"]
ImportClient --> ImportOK{"Import success?"}
ImportOK --> |No| WarnInstall["Warn about missing package and return null"]
ImportOK --> |Yes| CreateClient["createClient(url, key, {persistSession:false, autoRefreshToken:false})"]
CreateClient --> ReturnClient["Return Supabase client"]
```

**Diagram sources**
- [supabase-client.js:1-27](file://backend/src/supabase-client.js#L1-L27)
- [config.js:47-48](file://backend/src/config.js#L47-L48)

**Section sources**
- [supabase-client.js:1-27](file://backend/src/supabase-client.js#L1-L27)
- [config.js:42-52](file://backend/src/config.js#L42-L52)

### Session Tracking and Validation
- Creates login sessions with UUID session keys and associates them with player IDs.
- Validates sessions by ensuring the session key matches the expected player.
- Periodically purges expired sessions based on last_seen_at thresholds.

```mermaid
sequenceDiagram
participant HTTP as "http-server.js"
participant Svc as "session.js"
participant Supabase as "Supabase Client"
participant DB as "PostgreSQL"
HTTP->>Svc : "createLoginSession({supabase, playerId})"
Svc->>Supabase : "INSERT game_sessions {session_key, player_id}"
Supabase->>DB : "Execute"
DB-->>Supabase : "OK"
Supabase-->>Svc : "Success"
Svc-->>HTTP : "sessionKey"
HTTP->>Svc : "validateOrCreateSession({supabase, playerId, sessionKey})"
Svc->>Supabase : "SELECT player_id WHERE session_key"
Supabase->>DB : "Execute"
DB-->>Supabase : "Row or null"
Supabase-->>Svc : "Result"
Svc->>Supabase : "UPDATE last_seen_at"
Supabase->>DB : "Execute"
DB-->>Supabase : "OK"
Supabase-->>Svc : "Success"
Svc-->>HTTP : "true/false"
```

**Diagram sources**
- [session.js:23-86](file://backend/src/session.js#L23-L86)
- [http-server.js:221-251](file://backend/src/http-server.js#L221-L251)

**Section sources**
- [session.js:1-87](file://backend/src/session.js#L1-L87)
- [http-server.js:221-251](file://backend/src/http-server.js#L221-L251)

### Player and Car Data Access Patterns
- Retrieves players by ID or username with case-insensitive matching for usernames.
- Creates players with normalization and backward-compatible handling for newer columns.
- Manages cars with selection constraints, XML normalization, and test-drive state handling.
- Ensures only one selected car per player via unique partial indexes and updates.

```mermaid
sequenceDiagram
participant HTTP as "http-server.js"
participant USvc as "user-service.js"
participant Supabase as "Supabase Client"
participant DB as "PostgreSQL"
HTTP->>USvc : "getPlayerByUsername(supabase, username)"
USvc->>Supabase : "SELECT * FROM game_players WHERE ilike(username, ?)"
Supabase->>DB : "Execute"
DB-->>Supabase : "Row or null"
Supabase-->>USvc : "Data"
USvc-->>HTTP : "Player"
HTTP->>USvc : "createOwnedCar(supabase, {playerId, catalogCarId, ...})"
USvc->>Supabase : "INSERT game_cars"
Supabase->>DB : "Execute"
DB-->>Supabase : "New car row"
Supabase-->>USvc : "Data"
USvc->>Supabase : "UPDATE player default_car_game_id"
Supabase->>DB : "Execute"
DB-->>Supabase : "OK"
Supabase-->>USvc : "Success"
USvc-->>HTTP : "Normalized car"
```

**Diagram sources**
- [user-service.js:197-367](file://backend/src/user-service.js#L197-L367)
- [http-server.js:236-244](file://backend/src/http-server.js#L236-L244)

**Section sources**
- [user-service.js:184-367](file://backend/src/user-service.js#L184-L367)
- [http-server.js:236-244](file://backend/src/http-server.js#L236-L244)

### Team Structures and Membership Queries
- Lists teams by IDs with deterministic ordering.
- Retrieves team members ordered by contribution score and joined_at.
- Maintains team member count via triggers.

```mermaid
flowchart TD
Start(["listTeamsByIds(supabase, teamIds)"]) --> Normalize["Normalize and deduplicate IDs"]
Normalize --> Query["SELECT * FROM game_teams WHERE id IN (...)"]
Query --> Sort["Sort by input order"]
Sort --> Return["Return teams"]
Start2(["listTeamMembersForTeams(supabase, teamIds)"]) --> Normalize2["Normalize and deduplicate IDs"]
Normalize2 --> Query2["SELECT * FROM game_team_members WHERE team_id IN (...) ORDER BY team_id, contribution_score DESC, joined_at ASC"]
Query2 --> Return2["Return members"]
```

**Diagram sources**
- [user-service.js:588-638](file://backend/src/user-service.js#L588-L638)

**Section sources**
- [user-service.js:588-638](file://backend/src/user-service.js#L588-L638)

### Messaging System (game_mail)
- Supports inbox, sent, and trash folders with read/unread flags and optional monetary/point attachments.
- Retrieves paginated email lists with computed read/attachment flags.

```mermaid
sequenceDiagram
participant HTTP as "http-server.js"
participant USvc as "user-service.js"
participant Supabase as "Supabase Client"
participant DB as "PostgreSQL"
HTTP->>USvc : "handleGetEmailList(context)"
USvc->>Supabase : "SELECT id,sender_player_id,subject,is_read,created_at,attachment_money,attachment_points FROM game_mail WHERE recipient=? AND folder=? AND NOT is_deleted ORDER BY created_at DESC LIMIT N OFFSET M"
Supabase->>DB : "Execute"
DB-->>Supabase : "Rows"
Supabase-->>USvc : "Data"
USvc-->>HTTP : "XML payload with emails"
```

**Diagram sources**
- [user-service.js:956-1011](file://backend/src/user-service.js#L956-L1011)
- [perfect-schema.sql:171-196](file://backend/supabase/perfect-schema.sql#L171-L196)

**Section sources**
- [user-service.js:956-1011](file://backend/src/user-service.js#L956-L1011)
- [perfect-schema.sql:171-196](file://backend/supabase/perfect-schema.sql#L171-L196)

### Transition from Fixture-Based Responses to Database-Backed Data
- FixtureStore loads decoded HTTP responses keyed by URI, action, and decoded query to serve as fallbacks.
- HTTP server prioritizes Supabase-backed responses; if unavailable, serves fixture responses.
- This enables iterative migration: keep fixtures for static assets while moving dynamic logic to the database.

```mermaid
flowchart TD
Req(["Incoming Request"]) --> TrySupabase["Try Supabase handler"]
TrySupabase --> SupabaseOK{"Supabase OK?"}
SupabaseOK --> |Yes| ServeSupabase["Serve database-backed response"]
SupabaseOK --> |No| TryFixtures["Search fixture-store by keys"]
TryFixtures --> Found{"Fixture found?"}
Found --> |Yes| ServeFixture["Serve fixture response"]
Found --> |No| Fallback["Return 404 or generic"]
```

**Diagram sources**
- [http-server.js:410-424](file://backend/src/http-server.js#L410-L424)
- [fixture-store.js:75-86](file://backend/src/fixture-store.js#L75-L86)

**Section sources**
- [http-server.js:410-424](file://backend/src/http-server.js#L410-L424)
- [fixture-store.js:26-86](file://backend/src/fixture-store.js#L26-L86)

### Guidelines for Extending the Schema and Adding New Entities
- Add tables with appropriate foreign keys and constraints; prefer partial unique indexes for business rules (e.g., one selected car per player).
- Define indexes for frequent filters and joins; consider composite indexes for multi-column predicates.
- Use triggers/functions to maintain timestamps and derived aggregates (e.g., team member counts).
- Keep backward compatibility by handling missing columns gracefully in queries and inserts.
- Use RLS policies for service roles to bypass restrictions when needed.

**Section sources**
- [perfect-schema.sql:119-122](file://backend/supabase/perfect-schema.sql#L119-L122)
- [perfect-schema.sql:394-417](file://backend/supabase/perfect-schema.sql#L394-L417)
- [user-service.js:244-254](file://backend/src/user-service.js#L244-L254)
- [user-service.js:343-357](file://backend/src/user-service.js#L343-L357)

## Dependency Analysis
The runtime depends on configuration for Supabase credentials, initializes the client, and wires it into HTTP handlers and periodic tasks.

```mermaid
graph LR
CFG["config.js"] --> CLIENT["supabase-client.js"]
CLIENT --> HTTP["http-server.js"]
CLIENT --> SESS["session.js"]
CLIENT --> USVC["user-service.js"]
IDX["index.js"] --> HTTP
IDX --> SESS
HTTP --> FIXSTORE["fixture-store.js"]
HTTP --> FIXCAT["fixture-catalogs.js"]
USVC --> CARDEF["car-defaults.js"]
IDX --> TEAMSTATE["team-state.js"]
```

**Diagram sources**
- [config.js:42-52](file://backend/src/config.js#L42-L52)
- [supabase-client.js:1-27](file://backend/src/supabase-client.js#L1-L27)
- [http-server.js:253-521](file://backend/src/http-server.js#L253-L521)
- [session.js:1-87](file://backend/src/session.js#L1-L87)
- [user-service.js:1-661](file://backend/src/user-service.js#L1-L661)
- [index.js:1-95](file://backend/src/index.js#L1-L95)
- [fixture-store.js:1-86](file://backend/src/fixture-store.js#L1-L86)
- [fixture-catalogs.js:1-31](file://backend/src/fixture-catalogs.js#L1-L31)
- [car-defaults.js:1-32](file://backend/src/car-defaults.js#L1-L32)
- [team-state.js:1-40](file://backend/src/team-state.js#L1-L40)

**Section sources**
- [config.js:42-52](file://backend/src/config.js#L42-L52)
- [supabase-client.js:1-27](file://backend/src/supabase-client.js#L1-L27)
- [http-server.js:253-521](file://backend/src/http-server.js#L253-L521)
- [session.js:1-87](file://backend/src/session.js#L1-L87)
- [user-service.js:1-661](file://backend/src/user-service.js#L1-L661)
- [index.js:1-95](file://backend/src/index.js#L1-L95)
- [fixture-store.js:1-86](file://backend/src/fixture-store.js#L1-L86)
- [fixture-catalogs.js:1-31](file://backend/src/fixture-catalogs.js#L1-L31)
- [car-defaults.js:1-32](file://backend/src/car-defaults.js#L1-L32)
- [team-state.js:1-40](file://backend/src/team-state.js#L1-L40)

## Performance Considerations
- Indexes: Unique partial indexes enforce business rules efficiently; composite indexes optimize multi-column filters.
- Triggers: Automatic updated_at maintenance avoids application-level boilerplate.
- Cleanup: Periodic session purging prevents index bloat and maintains query performance.
- Backward compatibility: Graceful handling of missing columns reduces query failures during migrations.

[No sources needed since this section provides general guidance]

## Troubleshooting Guide
- Missing credentials: The client returns null and logs a warning; the server falls back to fixtures.
- Package not installed: Dynamic import fails; logs a warning and returns null.
- Session validation failures: Occur when session belongs to another player or does not exist; ensure login creates the session and subsequent requests pass the correct session key.
- Column compatibility errors: Queries handle missing columns by retrying without them; ensure migrations are applied.

**Section sources**
- [supabase-client.js:2-18](file://backend/src/supabase-client.js#L2-L18)
- [session.js:61-73](file://backend/src/session.js#L61-L73)
- [user-service.js:244-254](file://backend/src/user-service.js#L244-L254)
- [user-service.js:343-357](file://backend/src/user-service.js#L343-L357)

## Conclusion
The database integration leverages Supabase and PostgreSQL to provide robust, scalable persistence for player, session, car, team, and messaging data. The design balances performance with maintainability through indexes, triggers, and policies, while offering a smooth migration path from fixtures to live data. Backward compatibility and graceful fallbacks ensure reliability during transitions and deployments.

[No sources needed since this section summarizes without analyzing specific files]

## Appendices

### Migration Strategies
- Incremental schema additions: Add columns with defaults and apply indexes/functions post-deploy.
- Data normalization: Use repair routines to normalize legacy XML and IDs.
- RLS policies: Enable RLS and grant service role full access for backend operations.

**Section sources**
- [perfect-schema.sql:263-290](file://backend/supabase/perfect-schema.sql#L263-L290)
- [user-service.js:154-182](file://backend/src/user-service.js#L154-L182)

### Data Validation and Security
- Input sanitization: Username trimming, numeric normalization, and XML normalization.
- Session integrity: UUID-based session keys and strict validation.
- Access control: Service role bypass for backend; consider additional RLS for frontend roles.

**Section sources**
- [user-service.js:228-231](file://backend/src/user-service.js#L228-L231)
- [session.js:28-38](file://backend/src/session.js#L28-L38)
- [perfect-schema.sql:431-466](file://backend/supabase/perfect-schema.sql#L431-L466)