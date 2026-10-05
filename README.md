# TCERP — Steel & Iron B2B Trading ERP

Production-grade modular ERP/CRM for a steel trading company: CRM, Sales, Purchase,
Price Requests, Daily Pricing, Loading, Inventory, Accounting, Tax Invoicing,
Moadian (Iranian tax system), Workflow/Automation/Approval engines, and more.

## Stack

Next.js 14 + TypeScript (frontend, RTL/فارسی) · NestJS 10 (backend) · PostgreSQL 16 +
Prisma · Redis · MinIO (S3) · Docker Compose.

## Quick start (local development)

```bash
# 1. Infrastructure (PostgreSQL + Redis + MinIO)
docker compose up -d postgres redis minio

# 2. Backend
cp .env.example apps/backend/.env      # adjust if needed
cd apps/backend
npm install
npx prisma migrate deploy              # apply migrations
npx prisma db seed                     # admin user + roles + permissions
npm run start:dev                      # http://localhost:3001/api

# 3. Frontend (new terminal)
cd apps/frontend
npm install
npm run dev                            # http://localhost:3000
```

## First admin user (no default credentials)

The seed never ships default credentials. Before seeding, set:

```bash
SEED_ADMIN_USERNAME=admin
SEED_ADMIN_PASSWORD=<choose-a-strong-password>
```

- In **development**, if `SEED_ADMIN_PASSWORD` is unset, the seed auto-generates a strong
  password and prints it **once** to the terminal.
- In **production**, startup rejects known default/weak passwords —
  `SEED_ADMIN_PASSWORD` is required.

Change the password after first login (`must_change_password` is enforced for the seeded admin).

## Local port notes

- PostgreSQL is exposed on host port **5433** (5432 is occupied by a local service) —
  `docker-compose.yml` and `.env.example` already reflect this.
- MinIO is exposed on host port **9100** (9000 is occupied locally).

## Documentation

- [Requirements](docs/REQUIREMENTS.md)
- [Domain Map](docs/01-domain-map.md)
- [ERD](docs/02-erd.md)
- [Architecture](docs/03-architecture.md)
- [Progress](PROJECT_PROGRESS.md)
