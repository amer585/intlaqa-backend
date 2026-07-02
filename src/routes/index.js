'use strict';

const express = require('express');

const asyncHandler = require('../lib/asyncHandler');
const authenticateToken = require('../middleware/authenticateToken');
const { authRateLimiter } = require('../middleware/security');
const { loginStaff } = require('../services/auth.service');
const { registerStaff, addTeacher } = require('../services/staff.service');
const { loginStudent, saveStudent } = require('../services/student.service');
const { updateGrade } = require('../services/grade.service');
const { logActions } = require('../services/activity.service');
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

  router.post('/admin/add-teacher', authenticateToken, asyncHandler(async (req, res) => {
    res.status(201).json(await addTeacher(req.body, req.user));
  }));

  router.post('/addStudent', authenticateToken, asyncHandler(async (req, res) => {
    res.status(200).json(await saveStudent(req.body, req.user));
  }));

  router.post('/logAction', asyncHandler(async (req, res) => {
    res.status(200).json(await logActions(req.body));
  }));

  // ---- Student portal (full data: grades, attendance, schedule, announcements) ----
  router.get('/student/portal', asyncHandler(async (req, res) => {
    res.status(200).json(await getStudentPortal(req.query));
  }));

  return router;
}

module.exports = createApiRouter;
