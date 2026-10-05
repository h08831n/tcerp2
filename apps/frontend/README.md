# TCERP — Frontend

Next.js 14 (App Router, TypeScript) + Tailwind CSS 3 shell for the TCERP steel-trading ERP. Persian RTL UI, Vazirmatn font.

## Setup

```bash
cd apps/frontend
npm install
npm run dev
```

The app runs at http://localhost:3000 and expects the NestJS backend at http://localhost:3001/api (cookie-based auth, CORS with credentials).

## Environment variables

| Variable              | Default                     | Description                              |
| --------------------- | --------------------------- | ---------------------------------------- |
| `NEXT_PUBLIC_API_URL` | `http://localhost:3001/api` | Base URL of the backend REST API         |

Create a `.env.local` file to override:

```
NEXT_PUBLIC_API_URL=http://localhost:3001/api
```

## Scripts

- `npm run dev` — start the dev server
- `npm run build` — production build
- `npm run start` — start the production server
- `npm run lint` — ESLint (next/core-web-vitals)

## Structure

- `src/app/layout.tsx` — root layout: `lang="fa" dir="rtl"`, Vazirmatn via `next/font/google`
- `src/app/login/page.tsx` — RTL login page (POST `/auth/login`, redirects to `/dashboard`)
- `src/app/(app)/layout.tsx` — authenticated shell: `AuthProvider` + `AuthGate` fetch `/auth/me` and redirect to `/login` on failure; right sidebar (collapsible), header with search placeholder (`Ctrl+K` reserved), notification bell, user chip with logout (`/auth/logout`)
- `src/app/(app)/dashboard/page.tsx` — welcome card, KPI placeholders, quick actions
- `src/lib/api.ts` — `apiFetch` client helper: `credentials: "include"`, automatic single `POST /auth/refresh` + retry on 401, Persian error messages from the `{message}` envelope
- `src/lib/auth-context.tsx` — `AuthProvider` + `useAuth()` exposing `{ user, permissions, loading, refresh, logout }` (user/permissions loaded from `GET /auth/me`)
- `src/components/ui/` — `Button` (primary/secondary/danger/ghost, sm/md) and `Input` primitives

## Notes

- Sidebar module links are placeholders (`#`) except داشبورد (`/dashboard`).
- Search palette (Ctrl+K) is reserved but not yet implemented.
