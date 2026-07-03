# Intlaqa / Madrastna — Backend v4

![Express](https://img.shields.io/badge/Express-4-black) ![Node](https://img.shields.io/badge/Node-20-green) ![Turso/libSQL](https://img.shields.io/badge/DB-Turso%20libSQL-blue)

Hardened Express backend for the Madrastna school-management system. **The database
was rewritten from scratch (v4)** to be optimized for **both** low-latency reads
**and** low-latency writes, while keeping the public API contract identical so the
`men` portal (and the Android app) keep working unchanged.

> Same API contract as v3. Deployed to **Hugging Face Spaces** (Docker, port 7860).
> Two isolated **Turso/libSQL** databases: a *student* DB and a separate
> *teacher* account DB (double the free tier, isolated capacity + secrets).

---

## Why the database was rewritten (v3 → v4)

The v3 schema crammed every student's grades, attendance and weekly assessments
into **JSON blobs on the student row** (`grades_json`, `attendance_json`,
`weekly_json`). That optimized *reads* but was fundamentally broken for *writes*:

- **Lost updates / contention** — updating one subject grade meant
  *read the whole blob → mutate in JS → write the whole blob back*. Two teachers
  editing **different subjects** for the same student at the same time clobbered
  each other (last-write-wins = **lost data**) and held a lock on the whole row.
- **No history** — who/when a grade was set could never be stored, so the
  frontend's `{ teacher_id, updated_at }` on a grade was always `null`.
- **Un-queryable** — "all students below 50%" required a full table scan +
  per-row JSON parse.
- **No integrity** — free-form JSON, no constraints.

## What v4 does instead (optimized read AND write)

| Concern | Design |
|---|---|
| **Hot write** (grade entry) | One subject grade = **one row** in `student_grades`. A bulk upsert is a single libSQL **batch** (1 round trip, 1 transaction). Concurrent teachers on different subjects touch **different rows** → no contention, no lost data. |
| **Hot read** (student portal) | The whole portal (profile + grades + attendance + weekly + schedule + news) is fetched in **one round trip** via `batch()` across index-only scans. |
| **Indexes** | Primary keys double as access paths; a covering index makes the portal/roster grade read an **index-only scan**. |
| **Integrity** | `CHECK`, `UNIQUE`, `NOT NULL` everywhere instead of free-form JSON. |
| **Hierarchy reads** | A materialized `schools` dimension table replaces `SELECT DISTINCT …` scans over growing tables. |
| **Caching** | Disk cache (local SQLite) serves portal data with **0 Turso reads** until a write invalidates it; optional Upstash Redis cache-aside for student login. |

See **[`schema.sql`](schema.sql)** for the full design + rationale.

---

## Stack

- **Runtime:** Node 20 + Express
- **Database:** Turso / libSQL (SQLite) — 2 isolated DBs
- **Cache:** Upstash Redis (REST, cache-aside) + local disk cache
- **Auth:** bcrypt + JWT
- **Deploy:** Hugging Face Spaces (Docker, port 7860)

## Request workflow

1. Request → `helmet`, `compression`, CORS, rate-limit, JSON body cap.
2. `authenticateToken` verifies the Bearer JWT (public routes skip it).
3. Service layer validates input, applies **RBAC scope** (role + school/district/directorate), then reads (cache → DB, write-through) or writes (atomic `batch` transaction → cache invalidate).
4. Errors normalized to `{ error }`; nothing crashes the process.

## Schema (v4)

**Student DB** — `governorates`, `schools`, `staff`, `students`, `student_grades`,
`attendance`, `weekly_assessments`, `teacher_classes`, `activity_logs`, `portal_meta`.

**Teacher DB** — `teacher_accounts`, `teacher_student_relations`.

The schema is created **idempotently on boot** (`src/db/migrate.js`) via
`CREATE … IF NOT EXISTS`. On first run it also **auto-migrates legacy v3 data**:
- `teachers` → `staff` (id-preserving, then `teachers` is dropped)
- `grades_json` / `attendance_json` / `weekly_json` → exploded into normalized rows
- `schools` back-filled from existing students/staff
- legacy normalized tables (`student_grades`/`student_attendance`/`weekly_assessments`
  old shapes) detected, renamed aside, and copied in

Re-running is safe (a `schema_version` marker + `INSERT OR IGNORE` dedupe).

## Endpoints (base `/api`)

**Auth** — `POST /admin/register`, `POST /login`, `POST /studentLogin`,
`POST /teacher/register`, `POST /teacher/login`

**Hierarchy (staff)** — `GET /hierarchy/schools|districts|classes|students`

**Writes (staff)** — `POST /grades/update` (bulk), `POST /attendance/update` *(new)*,
`POST /admin/add-teacher`, `POST /admin/teacher-classes` *(new)*,
`GET /staff/teacher-classes` *(new)*, `POST /addStudent`, `POST /logAction`

**Student portal** — `GET /student/portal` (grades now include `teacher_id` + `updated_at`)

**Teacher account** — `GET|PATCH /teacher/profile`, `GET|POST /teacher/students`,
`GET /teacher/pending`, `PATCH /teacher/verify/:id`

**Status** — `GET /`, `GET /health`, `GET /api/status`

## Local development

```bash
cp .env.example .env        # fill in DATABASE_URL, TURSO_AUTH_TOKEN, JWT_SECRET, ...
npm install
npm run dev                 # node --watch  (auto-creates + migrates the schema on boot)
```

> ⚠️ Never commit `.env`. Every secret comes from the environment.

## Deploy to Hugging Face Spaces

1. Create a **Docker** Space (port 7860 is auto-exposed).
2. **Secrets:** `JWT_SECRET`, `DATABASE_URL`, `TURSO_AUTH_TOKEN`,
   `TEACHER_DATABASE_URL`, `TEACHER_DATABASE_TOKEN`, `UPSTASH_REDIS_REST_TOKEN`.
3. **Variables:** `CORS_ORIGINS`, `UPSTASH_REDIS_REST_URL`, `TRUST_PROXY=true`.
4. Push to the Space's git repo. The included GitHub Action
   (`.github/workflows/deploy-hf.yml`) mirrors `main` automatically using `HF_TOKEN`.
