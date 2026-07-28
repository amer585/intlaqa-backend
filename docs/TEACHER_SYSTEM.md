# Teacher Management System — v6 architecture

## The rule

> The **teacher database** contains everything about a *teacher* — login, name,
> email, phone, subject, verification state — **and nothing else**.
> The **student database** contains everything about a *student*.
> When a teacher wants a student, the student **is not in the teacher database**:
> the backend **imports** the record from the student database, **caches** it, and
> serves it. Whether the teacher is *adding* a student or *importing* one, the
> student row is **saved in the student database**. The backend is responsible
> for minting, edit, read, cache, and security.

## Physical layout

| Plane | Turso account | Tables |
|---|---|---|
| **Teacher** | `TEACHER_DATABASE_URL` + `TEACHER_DATABASE_TOKEN` | `teacher_accounts`, `teacher_student_relations` |
| **Student** | `DATABASE_URL` + `TURSO_AUTH_TOKEN` | `students`, `student_grades`, `attendance`, `weekly_assessments`, `staff`, `schools`, `teacher_classes`, `activity_logs`, `portal_meta`, reference tables |

Two separate Turso accounts → isolated capacity, isolated secrets, doubled free
limits. `teacher_student_relations.student_id` is a **soft cross-database FK** to
`students.ssn_encrypted`; libSQL cannot enforce it, so
`src/services/teacherStudent.service.js` validates existence explicitly.

The teacher plane provably stores no student facts — `teacher_accounts` has no
student columns and `teacher_student_relations` has exactly three:
`teacher_id`, `student_id`, `created_at`.

## Endpoints (all `/api`, all JWT-gated by `authenticateToken` + `requireTeacherAccount`)

| Method | Path | Plane written | What it does |
|---|---|---|---|
| `POST` | `/teacher/register` | teacher | Self-registration, lands `is_verified = 0` |
| `POST` | `/teacher/login` | — | 403 `PENDING_APPROVAL` until an admin approves; else issues a JWT (`type: "teacher_account"`) |
| `POST` | `/teacher/verification-status` | — | Credential-authenticated approval poll (no JWT exists yet while pending) |
| `GET` / `PATCH` | `/teacher/profile` | teacher | Read / edit identity only |
| `GET` | `/teacher/dashboard` | — | Header stats, derived from the cached roster |
| `GET` | `/teacher/students` | — | Roster: pointers from the teacher plane, **enriched from the student plane**, cached |
| **`GET`** | **`/teacher/students/search`** | — | **Searches the STUDENT database** by 14-digit id, id prefix, or Arabic name, narrowed by school/grade/class. Flags which hits are already imported. Cached 60 s per teacher |
| **`POST`** | **`/teacher/students/import`** | teacher (pointer) | Imports an **existing** student from the student DB. Validates existence, stores only `(teacher_id, student_id)`, warms the student cache |
| **`POST`** | **`/teacher/students/add`** | **student** | Creates a **new** student **in the student database**, then links it. The backend **mints** the 14-digit id when the client omits it |
| **`GET`** | **`/teacher/students/:id`** | — | Full academic view (profile + grades + attendance + weekly) imported from the student DB, cached 180 s |
| **`PATCH`** | **`/teacher/students/:id`** | **student** | Edit — the `UPDATE` lands in the student database |
| **`POST`** | **`/teacher/students/:id/grades`** | **student** | Upsert `student_grades` |
| **`POST`** | **`/teacher/students/:id/attendance`** | **student** | Upsert `attendance` |
| `DELETE` | `/teacher/students/:id` | teacher (pointer) | Removes **only** the relation — the student row survives in the student DB |
| `GET` | `/teacher/pending` | — | Staff-only approval queue |
| `PATCH` | `/teacher/verify/:id` | teacher | Staff-only approval |

## Security

1. `authenticateToken` — a valid `JWT_SECRET`-signed bearer token.
2. `requireTeacherAccount` — the JWT `type` must be `teacher_account`; a staff
   token cannot reach these routes.
3. `assertOwnsStudent(teacherId, studentId)` — **every** student read/write first
   confirms the `(teacher_id, student_id)` row exists in the teacher plane.
   A teacher therefore cannot touch a student they never imported, even by
   guessing a valid 14-digit id (403).
4. Login is impossible while `is_verified = 0`, so an unapproved teacher never
   obtains a token at all.
5. `authRateLimiter` fronts every credential endpoint.
6. Clients (web + Android) hold **only** a JWT. No database URL, no Turso token
   ships in the browser bundle or the APK.

## Caching (backend-owned, cache-aside)

| Key | TTL | Busted by |
|---|---|---|
| `teacher:<tid>:students` | 300 s | link / unlink / import / add / edit |
| `teacher:<tid>:student:<sid>` | 180 s | any write to that student |
| `teacher:<tid>:search:<hash>` | 60 s | import / add |
| `portal:<ssn>:<grade>` | disk ∞ / redis 365 d | prefix-swept on any student write |
| `student:<grade>:<ssn>` | 300 s | student profile writes |

Redis is primary (Upstash REST), local libSQL disk is the fallback; both degrade
to a direct DB read rather than failing a request.

`bustStudentCaches(studentId)` walks `idx_tsr_student` to find **every** teacher
that imported the student and invalidates all of their keys in one Upstash
pipeline — so teacher B never sees teacher A's stale write.

## Deployment

`.github/workflows/deploy-hf.yml` pushes this repo to the Hugging Face Space,
which runs `node src/server.js` on port 7860. Set as Space **secrets**:
`JWT_SECRET`, `DATABASE_URL`, `TURSO_AUTH_TOKEN`, `TEACHER_DATABASE_URL`,
`TEACHER_DATABASE_TOKEN`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`,
`CORS_ORIGINS`.

`src/db/migrate.js` self-creates both schemas on boot (`CREATE TABLE IF NOT
EXISTS`), so a fresh Turso database needs no manual step. Never commit a token —
`src/config/env.js` reads everything from the environment and degrades instead of
throwing when something is missing.
