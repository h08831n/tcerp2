# TCERP Backend

NestJS 10 + Prisma 5 + PostgreSQL foundation for the TCERP steel-trading ERP
(modular monolith, port **3001**, global prefix **/api**).

Covers: auth (JWT access + rotating refresh in HttpOnly cookies, failed-login
lockout), users/roles/permissions (effective = roles − REVOKE + GRANT
overrides), audit trail, settings, Jalali-aware document sequences, S3/MinIO
files with content-addressed dedupe, DB-backed queue (SKIP LOCKED, retry with
exponential backoff, dead-letter), and health check.

## Setup

```bash
npm install
cp ../../.env.example .env        # adjust DATABASE_URL / JWT secrets
npx prisma generate
npx prisma migrate deploy         # needs a running Postgres
npm run db:seed                   # permissions, system roles, admin user, sequences
npm run start:dev
```

The seed creates an admin user from `ADMIN_USERNAME` / `ADMIN_PASSWORD`
(default `admin` / `Admin@12345`, `mustChangePassword=true`).

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run build` | Compile (nest build) |
| `npm run start:dev` | Dev server with watch |
| `npm test` | Jest unit tests (no DB required — Prisma is mocked) |
| `npm run prisma:generate` | Generate the Prisma client |
| `npm run prisma:migrate` | `prisma migrate deploy` |
| `npm run db:seed` | Idempotent seed (ts-node prisma/seed.ts) |

## Layout

```
prisma/            schema.prisma, migrations/, seed.ts
src/
  common/          errors, exception filter, guards, decorators, DTOs, utils (jalali, phone)
  config/          zod-validated env (CONFIG token, global)
  prisma/          PrismaService (global)
  permissions/     effective-permission resolution (global)
  audit/           audit trail service + GET /api/audit
  auth/            login/refresh/logout/me, lockout
  users/ roles/ teams/ settings/ sequences/ queue/ files/ health/
```

Conventions: typed `AppError` subclasses → `{ statusCode, code, message, details, path, timestamp }`
error envelope; `@RequirePermissions(...)` enforced server-side by
`PermissionsGuard`; every write audited via `AuditService.record`; optimistic
locking (`version`) on users; settings/sequences config changes never rewrite
history.

## API endpoints

All routes require a valid access token (Bearer header or `access_token`
cookie) except `POST /api/auth/*` and `GET /api/health`.

### Auth (public)

| Method | Path | Permission |
| --- | --- | --- |
| POST | `/api/auth/login` | public |
| POST | `/api/auth/refresh` | public (refresh cookie) |
| POST | `/api/auth/logout` | public |
| GET | `/api/auth/me` | authenticated |

### Health (public)

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/health` | public (503 when the DB is down) |

### Users

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/users` (`?page,&pageSize,&search,&status`) | `users.view` |
| POST | `/api/users` | `users.create` |
| GET | `/api/users/:id` | `users.view` |
| PATCH | `/api/users/:id` (body includes `version` — optimistic lock, `VERSION_CONFLICT` on mismatch) | `users.edit` |
| DELETE | `/api/users/:id` (soft → `DISABLED`) | `users.delete` |
| POST | `/api/users/:id/password` | `users.reset_password` |
| PUT | `/api/users/:id/roles` `{roleIds}` | `users.edit` |

### Roles & permission catalog

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/roles` | `roles.view` |
| POST | `/api/roles` | `roles.create` |
| GET | `/api/roles/:id` | `roles.view` |
| PATCH | `/api/roles/:id` | `roles.edit` |
| DELETE | `/api/roles/:id` (system roles protected) | `roles.delete` |
| PUT | `/api/roles/:id/permissions` `{permissionIds}` | `roles.edit` |
| GET | `/api/permissions` (catalog) | `roles.view` |

### Teams

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/teams` | `teams.view` |
| POST | `/api/teams` | `teams.create` |
| GET | `/api/teams/:id` | `teams.view` |
| PATCH | `/api/teams/:id` | `teams.edit` |
| DELETE | `/api/teams/:id` | `teams.delete` |

### Settings

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/settings` (`?category=`) | `settings.view` |
| PUT | `/api/settings` `{key, value, category?}` (upsert, audited old/new) | `settings.edit` |

### Sequences (`SD-1405-00125` format)

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/sequences` | `sequences.view` |
| POST | `/api/sequences/:code/allocate` (admin/testing) | `sequences.edit` |
| PUT | `/api/sequences/:id` (prospective config only; counters never rewritten) | `sequences.edit` |

### Files (S3/MinIO, sha256 dedupe)

| Method | Path | Permission |
| --- | --- | --- |
| POST | `/api/files` (multipart field `file`) | `files.upload` |
| POST | `/api/files/:id/attachments` `{entityType, entityId, category?}` | `files.upload` |
| GET | `/api/files/:id` | `files.view` |
| GET | `/api/files/:id/download` | `files.download` |

### Queue

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/queue/jobs` (`?status=&jobType=&page=&pageSize=`) | `queue.view` |
| POST | `/api/queue/jobs/:id/retry` (FAILED/CANCELLED → PENDING) | `queue.retry` |
| POST | `/api/queue/jobs/:id/cancel` (PENDING/RETRYING → CANCELLED) | `queue.retry` |

### Audit

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/audit` (`?entityType=&entityId=&actorId=&action=`) | `audit.view` |

## Permission catalog (seeded)

`users.view/create/edit/delete/reset_password`, `roles.view/create/edit/delete`,
`teams.view/create/edit/delete`, `settings.view/edit`,
`sequences.view/edit`, `audit.view`, `files.view/upload/download/delete`,
`queue.view/retry` — 24 rows.

System roles (idempotently seeded): `admin` (all), `salesperson`,
`sales_manager`, `buyer`, `purchase_manager`, `accountant`,
`financial_manager`, `pricing_user`.

## Tests

`npm test` — 60 unit tests, no database needed: Jalali conversion (incl. leap
years 1403/1399 and round-trips), Iranian mobile normalization, login lockout,
sequence format/yearly-reset/increment (mocked transaction), effective
permissions (roles − REVOKE + GRANT), queue backoff curve.
