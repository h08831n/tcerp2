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

Default admin: `admin` / `Admin@12345` (must change password on first login).

## Documentation

- [Requirements](docs/REQUIREMENTS.md)
- [Domain Map](docs/01-domain-map.md)
- [ERD](docs/02-erd.md)
- [Architecture](docs/03-architecture.md)
- [Progress](PROJECT_PROGRESS.md)
