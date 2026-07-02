---
title: Intlaqa Backend
emoji: 📚
colorFrom: green
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---

# Intlaqa / Madrastna — Backend v3 (PostgreSQL + Redis + Hugging Face)

Hardened Express backend for the school-management system. Same API contract
as before (the `men` portal keeps working), now on a **single PostgreSQL
database** with an optional **Upstash Redis** cache layer, deployed to
**Hugging Face Spaces**.

> The old MySQL/TiDB (4-database) + Gigalixir setup is retired. One database
> for now — the grade-routing seam (`getDbUrl`) stays so we can split into 4
> later without touching call sites.

---

## Stack
- **Runtime:** Node 20 + Express
- **Database:** PostgreSQL (single DB — e.g. Aiven always-free)
- **Cache:** Upstash Redis (REST API, cache-aside)
- **Auth:** bcrypt + JWT
- **Deploy:** Hugging Face Spaces (Docker, port 7860)

---

## Request workflow
1. Request hits Express → `helmet`, `compression`, restricted CORS, rate-limit, JSON body cap.
2. `authenticateToken` middleware verifies the Bearer JWT (public routes skip this).
3. Service layer validates input, applies **RBAC scope** (role + school/district/directorate), then:
   - **Reads:** check Redis first (cache-aside) → PostgreSQL → write-through to Redis.
   - **Writes:** run inside a Postgres **transaction** (bulk queries, atomic), then invalidate cache.
4. Every grade/grade-band lookup goes through `getDbUrl(grade)` → the single DB URL today.
5. Errors are normalised into `{ error }` JSON; nothing panics the process.

---

## What was fixed (v1 → v3)
Hardcoded JWT secret → fails closed without a strong secret. Plaintext-password
fallback → bcrypt-only. Broken SSL → configurable `DB_SSL_MODE`. Open CORS →
restricted. No rate limiting → global + auth limiters. Non-atomic N+1 grade
writes → one transaction with bulk queries. Always-on demo login → env-gated.
Plus: MySQL/TiDB → PostgreSQL, 4 DBs → 1, Gigalixir → Hugging Face, Redis cache.

---

## Endpoints (unchanged contract, base `/api`)
`GET /`, `GET /health`, `POST /api/admin/register`, `POST /api/login`,
`POST /api/studentLogin`, `POST /api/addStudent`, `POST /api/grades/update`,
`POST /api/admin/add-teacher`, `GET /api/hierarchy/schools|districts|classes|students`,
`POST /api/logAction`.

---

## Local development
```bash
cp .env.example .env       # fill in DATABASE_URL, JWT_SECRET, CORS_ORIGINS, ...
psql "$DATABASE_URL" -f schema.sql
npm install
npm test                   # unit tests
npm run dev                # node --watch
```

---

## Deploy to Hugging Face Spaces
1. Create a **Docker** Space (blank template).
2. Add **Secrets**: `JWT_SECRET`, `DATABASE_URL`, `UPSTASH_REDIS_REST_TOKEN`.
3. Add **Variables**: `CORS_ORIGINS`, `UPSTASH_REDIS_REST_URL`, `DB_SSL_MODE=require`.
4. Push this folder's contents to the Space's git repo (port 7860 is auto-exposed).

The included GitHub Action (`.github/workflows/deploy-hf.yml`) mirrors `main`
to the HF Space automatically using `HF_TOKEN`.

> ⚠️ Never commit `.env`. Every secret comes from the environment (HF Secrets/Variables).
