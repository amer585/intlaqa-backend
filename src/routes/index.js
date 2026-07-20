'use strict';

const express = require('express');

const asyncHandler = require('../lib/asyncHandler');
const AppError = require('../lib/AppError');
const authenticateToken = require('../middleware/authenticateToken');
const requireTeacherAccount = require('../middleware/requireTeacherAccount');
const requireStaffRole = require('../middleware/requireStaffRole');
const { authRateLimiter } = require('../middleware/security');
const { loginStaff } = require('../services/auth.service');
const { registerStaff, addTeacher, assignTeacherClass, listTeacherClasses } = require('../services/staff.service');
const {
  registerTeacher,
  loginTeacher,
  checkVerificationStatus,
  getTeacherProfile,
  updateTeacherProfile,
  linkStudent,
  unlinkStudent,
  listTeacherStudents,
  listPendingTeachers,
  setTeacherVerification,
} = require('../services/teacherAccount.service');
const { loginStudent, saveStudent } = require('../services/student.service');
const { updateGrade } = require('../services/grade.service');
const { updateAttendance } = require('../services/attendance.service');
const { logActions } = require('../services/activity.service');
const { getStudentPortal } = require('../services/studentPortal.service');
const {
  getClassesForHierarchy,
  getDistrictsForUser,
  getSchoolsForUser,
  getStudentsForHierarchy,
} = require('../services/hierarchy.service');

function createApiRouter() {
  const router = express.Router();

  // ---- Auth (rate-limited to blunt brute force) ----
  router.post('/admin/register', authRateLimiter, asyncHandler(async (req, res) => {
    res.status(201).json(await registerStaff(req.body));
  }));

  router.post('/login', authRateLimiter, asyncHandler(async (req, res) => {
    res.status(200).json(await loginStaff(req.body));
  }));

  router.post('/studentLogin', authRateLimiter, asyncHandler(async (req, res) => {
    res.status(200).json(await loginStudent(req.body));
  }));

  // ---- Protected hierarchy reads ----
  router.get('/hierarchy/schools', authenticateToken, asyncHandler(async (req, res) => {
    res.status(200).json({ schools: await getSchoolsForUser(req.user, req.query) });
  }));

  router.get('/hierarchy/districts', authenticateToken, asyncHandler(async (req, res) => {
    res.status(200).json({ districts: await getDistrictsForUser(req.user) });
  }));

  router.get('/hierarchy/classes', authenticateToken, asyncHandler(async (req, res) => {
    res.status(200).json({ classes: await getClassesForHierarchy(req.query, req.user) });
  }));

  router.get('/hierarchy/students', authenticateToken, asyncHandler(async (req, res) => {
    res.status(200).json(await getStudentsForHierarchy(req.query, req.user));
  }));

  // ---- Protected writes ----
  router.post('/grades/update', authenticateToken, asyncHandler(async (req, res) => {
    res.status(200).json(await updateGrade(req.body, req.user));
  }));

  router.post('/attendance/update', authenticateToken, asyncHandler(async (req, res) => {
    res.status(200).json(await updateAttendance(req.body));
  }));

  // Assign / list teacher→(class,subject) authorization (grade-edit scope).
  router.post('/admin/teacher-classes', authenticateToken, asyncHandler(async (req, res) => {
    res.status(201).json(await assignTeacherClass(req.body, req.user));
  }));

  router.get('/staff/teacher-classes', authenticateToken, asyncHandler(async (req, res) => {
    res.status(200).json(await listTeacherClasses(req.user, req.query));
  }));

  router.post('/admin/add-teacher', authenticateToken, asyncHandler(async (req, res) => {
    res.status(201).json(await addTeacher(req.body, req.user));
  }));

  router.post('/addStudent', authenticateToken, asyncHandler(async (req, res) => {
    res.status(200).json(await saveStudent(req.body, req.user));
  }));

  // v5 — gate /logAction (was unauth + anonymously writable). Tier-aware:
  // students may only log actions for their own ssn (anti-ssn-enumeration);
  // staff/teacher callers may log for any.
  router.post('/logAction', authenticateToken, asyncHandler(async (req, res) => {
    if (req.user.type === 'student' && req.user.ssn_encrypted) {
      const entries = Array.isArray(req.body) ? req.body : [req.body];
      for (const e of entries) {
        if (e && e.ssn_encrypted && String(e.ssn_encrypted) !== String(req.user.ssn_encrypted)) {
          throw new AppError(403, 'Forbidden: students can only log their own actions.');
        }
      }
    }
    res.status(200).json(await logActions(req.body));
  }));

  // v5 — Student portal (full data: grades, attendance, schedule, announcements).
  // POST (was GET) + authRateLimiter + authenticateToken. SSN moves OUT of the
  // URL into the JWT (no SSNs in proxy / HF access logs / browser history).
  // Tier-aware: when the caller is a student JWT, IGNORE the body ssn/grade and
  // use the JWT's — anti-impersonation (a logged-in student can ONLY read their
  // own portal). Staff/teacher callers (e.g. teacher dashboard expanding a
  // linked student's portal) MAY pass body ssn/grade to look up an arbitrary
  // student.
  router.post('/student/portal', authRateLimiter, authenticateToken, asyncHandler(async (req, res) => {
    const query = req.user.type === 'student'
      ? { ssn_encrypted: req.user.ssn_encrypted, grade_level: req.user.grade_level }
      : (req.body || {});
    res.status(200).json(await getStudentPortal(query));
  }));

  // ---- Teacher account workflow (email self-registration → admin approval → JWT) ----
  router.post('/teacher/register', authRateLimiter, asyncHandler(async (req, res) => {
    res.status(201).json(await registerTeacher(req.body));
  }));

  router.post('/teacher/login', authRateLimiter, asyncHandler(async (req, res) => {
    res.status(200).json(await loginTeacher(req.body));
  }));

  // Pending teachers can't log in (403 before a JWT is issued) — this
  // credential-authenticated check lets them poll their approval state.
  router.post('/teacher/verification-status', authRateLimiter, asyncHandler(async (req, res) => {
    res.status(200).json(await checkVerificationStatus(req.body));
  }));

  router.get('/teacher/profile', authenticateToken, requireTeacherAccount, asyncHandler(async (req, res) => {
    res.status(200).json(await getTeacherProfile(req.user));
  }));

  router.patch('/teacher/profile', authenticateToken, requireTeacherAccount, asyncHandler(async (req, res) => {
    res.status(200).json(await updateTeacherProfile(req.body, req.user));
  }));

  router.get('/teacher/students', authenticateToken, requireTeacherAccount, asyncHandler(async (req, res) => {
    res.status(200).json(await listTeacherStudents(req.user));
  }));

  router.post('/teacher/students', authenticateToken, requireTeacherAccount, asyncHandler(async (req, res) => {
    res.status(201).json(await linkStudent(req.body, req.user));
  }));

  // Unlink: removes ONLY the relation in the teacher DB — the student record
  // stays in the student DB. Busts the teacher's cached roster.
  router.delete('/teacher/students/:id', authenticateToken, requireTeacherAccount, asyncHandler(async (req, res) => {
    res.status(200).json(await unlinkStudent(req.params.id, req.user));
  }));

  // ---- Admin approval of teacher accounts (staff-only) ----
  router.get(
    '/teacher/pending',
    authenticateToken,
    requireStaffRole('admin', 'principal', 'directorate', 'directorate_manager', 'district', 'district_manager'),
    asyncHandler(async (req, res) => {
      res.status(200).json(await listPendingTeachers(req.user));
    }),
  );

  router.patch(
    '/teacher/verify/:id',
    authenticateToken,
    requireStaffRole('admin', 'principal', 'directorate', 'directorate_manager', 'district', 'district_manager'),
    asyncHandler(async (req, res) => {
      res.status(200).json(await setTeacherVerification(req.params.id, req.user));
    }),
  );

  return router;
}

module.exports = createApiRouter;
