# Getting Started

<cite>
**Referenced Files in This Document**
- [README.md](file://backend/README.md)
- [package.json](file://backend/package.json)
- [config.js](file://backend/src/config.js)
- [supabase-client.js](file://backend/src/supabase-client.js)
- [http-server.js](file://backend/src/http-server.js)
- [index.js](file://backend/src/index.js)
- [schema.sql](file://backend/supabase/schema.sql)
- [deploy_vps.sh](file://backend/deploy_vps.sh)
- [ecosystem.config.cjs](file://backend/ecosystem.config.cjs)
- [nginx.nl.conf](file://backend/nginx.nl.conf)
</cite>

## Table of Contents
1. [Introduction](#introduction)
2. [Prerequisites](#prerequisites)
3. [Installation](#installation)
4. [Environment Configuration](#environment-configuration)
5. [Local Development](#local-development)
6. [Verification](#verification)
7. [Troubleshooting](#troubleshooting)
8. [Windows vs Unix-like Compatibility](#windows-vs-unix-like-compatibility)
9. [Next Steps](#next-steps)

## Introduction
This guide helps you set up the Nitto Legends Community Backend locally and on a VPS. It covers prerequisites, Supabase setup, database schema, environment configuration, and running the backend. It also includes verification steps and troubleshooting tips for common issues.

## Prerequisites
- Node.js
  - Version requirement: The project uses ES modules and modern Node.js features. Use a recent LTS version compatible with the repository’s scripts and imports.
  - Confirm availability: node --version
- Git (recommended for cloning the repository)
- A modern browser for accessing local endpoints during testing
- Supabase account and project
  - You will need your Supabase project URL and a Service Role key for database access

Notes:
- The backend uses ES modules (type: module in package.json). Ensure your Node.js version supports this.
- The deployment script installs Node.js 22 via nodesource; refer to the VPS script for a supported version baseline.

**Section sources**
- [package.json:1-15](file://backend/package.json#L1-L15)
- [deploy_vps.sh:23-26](file://backend/deploy_vps.sh#L23-L26)

## Installation
Follow these steps to prepare the backend locally:

1. Clone or download the repository to your machine.
2. Install dependencies:
   - From the backend directory, run: npm install
3. Prepare the database schema:
   - Log in to your Supabase project.
   - Open the SQL Editor.
   - Run the schema.sql script located at backend/supabase/schema.sql.
4. Configure environment variables:
   - Copy .env.example to .env in the backend directory.
   - Fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
5. Start the backend:
   - Development mode: npm run dev
   - Production mode: npm start

Notes:
- The README outlines the quick-start steps and lists supported actions.
- The schema creates tables for players, sessions, cars, teams, and mail, along with triggers and indexes.

**Section sources**
- [README.md:12-19](file://backend/README.md#L12-L19)
- [schema.sql:1-325](file://backend/supabase/schema.sql#L1-L325)

## Environment Configuration
The backend reads configuration from environment variables and a .env file. The config loader:
- Loads .env from the backend root
- Ignores comments and malformed lines
- Merges .env values with process.env
- Exposes defaults for host, port, TCP host/port, and Supabase credentials

Key variables:
- HTTP_HOST: HTTP server bind host (default: 127.0.0.1)
- HOST: Fallback host if HTTP_HOST is not set
- PORT: HTTP server port (default: 8082)
- TCP_HOST: TCP server bind host (default: 127.0.0.1)
- TCP_PORT: TCP server port (default: 3724)
- SUPABASE_URL: Supabase project URL
- SUPABASE_SERVICE_ROLE_KEY: Supabase Service Role key

Behavior:
- If SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY are missing, the backend runs in fixture-only mode and logs a warning.
- The Supabase client is lazily imported; if the package is not installed, the backend logs a warning and runs in fixture-only mode.

**Section sources**
- [config.js:10-52](file://backend/src/config.js#L10-L52)
- [supabase-client.js:1-27](file://backend/src/supabase-client.js#L1-L27)

## Local Development
After installing dependencies and preparing the database:

1. Ensure your Supabase project is ready and schema is applied.
2. Set environment variables in .env:
   - SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
   - Optionally adjust HTTP_HOST, PORT, TCP_HOST, TCP_PORT
3. Start the server:
   - Development: npm run dev
   - Production: npm start

What happens at startup:
- The server initializes services (race rooms, rivals state, team state, TCP proxy, TCP notify, TCP server).
- An HTTP server listens on the configured host/port.
- A TCP server listens on the configured TCP host/port.
- Periodic cleanup tasks run for in-memory state and expired sessions.

**Section sources**
- [index.js:14-95](file://backend/src/index.js#L14-L95)
- [http-server.js:253-521](file://backend/src/http-server.js#L253-L521)

## Verification
After starting the backend, verify the setup:

- Health check
  - HTTP: curl http://127.0.0.1:8082/healthz
  - Expected: ok
- Basic endpoint
  - curl http://127.0.0.1:8082/
  - Should return HTML content
- Supabase connectivity
  - If .env is configured, the backend attempts to connect to Supabase and logs connection status
  - If credentials are missing, the backend runs in fixture-only mode

Optional checks:
- TCP listener: ss -tulpn | grep 3724 (Linux/macOS) or netstat -ano | findstr :3724 (Windows)
- Firewall: ensure port 3724 is allowed if testing external clients

**Section sources**
- [http-server.js:367-377](file://backend/src/http-server.js#L367-L377)
- [index.js:86-94](file://backend/src/index.js#L86-L94)

## Troubleshooting
Common issues and fixes:

- Missing Supabase credentials
  - Symptom: Warning about missing Supabase credentials; backend runs in fixture-only mode
  - Fix: Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env
- Supabase client not installed
  - Symptom: Warning about missing @supabase/supabase-js; backend runs in fixture-only mode
  - Fix: Run npm install in the backend directory
- Port conflicts
  - Symptom: Cannot start HTTP or TCP server on configured ports
  - Fix: Change PORT or TCP_PORT in .env; ensure no other process is using the ports
- Node.js version mismatch
  - Symptom: Errors related to ES modules or unsupported syntax
  - Fix: Use a compatible Node.js version (refer to package.json and deployment script)
- Windows-specific path issues
  - The backend uses Node.js built-in modules and does not rely on OS-specific APIs; however, ensure paths in .env and shell commands are correct
- Schema not applied
  - Symptom: Errors when interacting with tables or missing tables
  - Fix: Re-run the schema.sql script in the Supabase SQL Editor

**Section sources**
- [supabase-client.js:10-18](file://backend/src/supabase-client.js#L10-L18)
- [config.js:42-52](file://backend/src/config.js#L42-L52)
- [deploy_vps.sh:23-26](file://backend/deploy_vps.sh#L23-L26)

## Windows vs Unix-like Compatibility
- Node.js and npm
  - Use a recent LTS Node.js version; the repository uses ES modules
- Shell scripts
  - The deployment script is a Bash script intended for Unix-like systems. On Windows, use WSL or Git Bash to run it
- Ports
  - TCP port 3724 is commonly used; ensure firewall allows inbound connections on Windows Defender Firewall
- File paths
  - The backend relies on Node.js filesystem APIs; ensure .env and paths are valid on your platform

**Section sources**
- [package.json:5](file://backend/package.json#L5)
- [deploy_vps.sh:1-115](file://backend/deploy_vps.sh#L1-L115)

## Next Steps
- Explore supported actions and starter tables documented in the README
- Test with a legacy client pointing to your backend
- Review the schema for tables and indexes to understand data model coverage
- For production, review the VPS deployment script and PM2 configuration

**Section sources**
- [README.md:21-48](file://backend/README.md#L21-L48)
- [schema.sql:1-325](file://backend/supabase/schema.sql#L1-L325)
- [ecosystem.config.cjs:1-20](file://backend/ecosystem.config.cjs#L1-L20)
- [nginx.nl.conf:1-18](file://backend/nginx.nl.conf#L1-L18)