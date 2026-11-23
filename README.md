# AaharGrid

A local prototype for coordinating surplus-food donations, based on the attached WasteWise MCA report. The interface uses Angular and Tailwind CSS; the API uses Node.js, Express and PostgreSQL. Amazon Cognito User Pools provides authentication. Forecasting and AWS hosting are not implemented.

## Local demo without login

For a simulated demo without Docker, PostgreSQL installation or Cognito configuration:

```sh
npm --prefix backend install
npm --prefix frontend install
npm --prefix backend run demo
```

In another terminal run `npm --prefix frontend start -- --host 127.0.0.1`, then open http://127.0.0.1:4200/. Use the demo-role selector to switch between donor, recipient, volunteer and administrator. The demo starts an isolated PostgreSQL instance on port 55432 and stores simulated data and a generated database password in the ignored `backend/.demo-data` directory. Data persists across restarts; the example listing and recipient availability expire naturally.

**Demo mode disables authentication:** it is explicitly enabled by the demo command, listens only on localhost, and must never be used for real data or exposed publicly. Other local users can access the demo API. Normal startup still requires Cognito and PostgreSQL configuration; `NODE_ENV=production` refuses demo mode.

### API documentation

With the backend running, open [Swagger UI](http://127.0.0.1:3000/docs/). In demo mode, click **Authorize** and enter `donor`, `recipient`, `volunteer`, or `admin` to exercise the API as that role. These roles are simulated and have no login. In normal mode, authorize with a Cognito access token instead. Changing data through Swagger affects the configured database.

## What is implemented

- Cognito managed sign-in, registration and recovery using authorization code with PKCE; the API verifies Cognito access tokens and resolves application roles from PostgreSQL.
- Donor, recipient, volunteer and administrator profiles, approval, role and ownership checks.
- Food listing creation, editing and closure; matching, requests and transactionally guarded allocations.
- Volunteer assignment and pickup updates, recipient receipt confirmation, in-app notifications, role-scoped counts and administrator audit events.
- Explicit food-safety declaration and handling details. The platform does **not** certify food safety.

## Prerequisites

- Node.js supported by the installed Angular version (Node 26 was used for the build), npm and PostgreSQL 17, or Docker with Compose.
- An AWS account with a configured Cognito User Pool. No AWS credentials or client secret are stored in this repository.

### Configure Cognito

1. Create a Cognito User Pool with email verification and a managed-login domain.
2. Create a **public** app client without a client secret. Enable the authorization-code grant and the `openid` scope. Allow callback and sign-out URLs `http://localhost:4200/` (include the trailing slash). Configure sign-up and recovery in Cognito.
3. Copy `backend/.env.example` to `backend/.env`. Set `DATABASE_URL`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, and `COGNITO_DOMAIN` (the complete `https://...` domain, without a trailing slash). The frontend receives only the public client ID and domain from `/api/config`.
4. Configure the user pool to require verified email before sign-in. Credentials and passwords stay with Cognito, not this application.

## Start locally

```sh
docker compose up -d
npm --prefix backend install
npm --prefix frontend install
npm --prefix backend run migrate
npm --prefix backend run dev
```

In another terminal:

```sh
npm --prefix frontend start
```

Open http://localhost:4200. Angular proxies `/api` to port 3000. Alternatively, provision PostgreSQL separately and update `DATABASE_URL`. The Compose password is **only for local development**. Do not expose this setup to the public internet; production needs HTTPS, secret management, appropriate database credentials and deployment hardening.

### First administrator

Sign up through Cognito and submit an application profile. Find that user's Cognito `sub` in the Cognito console, then use an authorized database operator to run the following parameterized administrative operation with the actual subject substituted safely in the database client:

```sql
UPDATE users SET role = 'admin', status = 'approved'
WHERE cognito_sub = '<verified-cognito-sub>';
```

Sign in again and approve other profiles in Administration. Never use a user's email as a substitute for the verified Cognito subject. Administrators are not self-assignable through the API. Approved organizations cannot change their organization name through the profile API; an administrator must review and update it directly in the database.

### Demonstration data

Optionally run `ALLOW_DEMO_SEED=true npm --prefix backend run seed` after migration. The seed contains fictional records and non-login users, not real donations. It is repeatable and inserts one completed example. It does not create Cognito accounts; use real test accounts in your own user pool to demonstrate interactive flows. Never describe simulated counts as actual food redistributed.

## Workflow

1. An administrator approves donor, recipient and volunteer profiles.
2. The recipient sets coordinates, service radius, accepted categories and dietary types, capacity, availability and pickup readiness. Capacity is interpreted in the offered listing's unit; use consistent units when comparing candidates.
3. A donor publishes a complete listing. An eligible recipient sees it and requests a quantity.
4. The donor accepts or rejects the request. An accepted allocation is locked against concurrent over-allocation.
5. The recipient assigns an approved volunteer. The volunteer accepts, collects and delivers; a failed task can be reassigned.
6. The recipient confirms the received quantity. Receipt counts reflect confirmations, not listings or pickup alone.

Editing a listing rejects pending requests. A listing with accepted allocations cannot be edited or closed. Food not actually received is not automatically reallocated. A listing becomes unavailable to new requests after its deadline; expired rows remain in history.

### Matching rules

Only approved, pickup-ready recipients with coordinates, a positive service radius, sufficient capacity, compatible category and dietary type, and an overlapping availability window are eligible. Closed, reserved or expired listings and distances outside the service radius are excluded. Missing required preference data means **no match**, not a default high score. Distance uses the Haversine formula. The provisional score is `0.30 × distance + 0.25 × quantity fit + 0.20 × time overlap + 0.15 × category compatibility + 0.10 × pickup readiness`, with normalized factors from 0 to 100. Category and readiness score 100 after the mandatory checks. These weights are assumptions, not validated real-world outcomes.

## SDLC and verification

The attached report defines requirements, roles, architecture, acceptance criteria and planned evaluation. This repository implements a local prototype; the report's result tables should only be filled with tests actually performed. Run:

```sh
npm --prefix backend run build
npm --prefix backend test
npm --prefix frontend run build
```

The automated matching tests cover suitable, distant, expired, incompatible and incomplete scenarios. Actual Cognito login/recovery, PostgreSQL integration, concurrent allocation, role-access and responsive browser flows must also be tested in the configured environment before claiming end-to-end completion. Record the date, inputs, expected and actual outcomes and screenshots for the MCA submission.

## Current limitations

The prototype has not been validated against a live Cognito pool or PostgreSQL service in this workspace. Deadline reminder scheduling, user-facing moderation reports, an administrator interface for editing organization identity, sophisticated category management, detailed quantity-by-unit analytics, and forecasting are not implemented. Food safety, user verification and applicable legal obligations remain with the responsible participants and platform operator. Do not use this prototype for real donations without a security review, operational controls and additional integration testing.
