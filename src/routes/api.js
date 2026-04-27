const express = require('express');

const asyncHandler = require('../lib/asyncHandler');
const authenticateToken = require('../middleware/authenticateToken');
const { loginStaff } = require('../services/authService');
const { registerStaff, addTeacher } = require('../services/staffService');
const { getSchoolsForUser, getStudentsForHierarchy } = require('../services/hierarchyService');
const { updateGrade } = require('../services/gradeService');
const { loginStudent, saveStudent } = require('../services/studentService');
const { logActions } = require('../services/activityService');

function createApiRouter() {
  const router = express.Router();

  router.post('/admin/register', asyncHandler(async (req, res) => {
    const result = await registerStaff(req.body);
    res.status(201).json(result);
  }));

  router.post('/login', asyncHandler(async (req, res) => {
    const result = await loginStaff(req.body);
    res.status(200).json(result);
  }));

  router.get('/hierarchy/schools', authenticateToken, asyncHandler(async (req, res) => {
    const schools = await getSchoolsForUser(req.user);
    res.status(200).json({ schools });
  }));

  router.get('/hierarchy/students', authenticateToken, asyncHandler(async (req, res) => {
    const students = await getStudentsForHierarchy(req.query, req.user);
    res.status(200).json({ students });
  }));

  router.post('/grades/update', authenticateToken, asyncHandler(async (req, res) => {
    const result = await updateGrade(req.body, req.user);
    res.status(200).json(result);
  }));

  router.post('/admin/add-teacher', authenticateToken, asyncHandler(async (req, res) => {
    const result = await addTeacher(req.body, req.user);
    res.status(201).json(result);
  }));

  router.post('/studentLogin', asyncHandler(async (req, res) => {
    const result = await loginStudent(req.body);
    res.status(200).json(result);
  }));

  router.post('/addStudent', authenticateToken, asyncHandler(async (req, res) => {
    const result = await saveStudent(req.body, req.user);
    res.status(200).json(result);
  }));

  router.post('/logAction', asyncHandler(async (req, res) => {
    const result = await logActions(req.body);
    res.status(200).json(result);
  }));

  return router;
}

module.exports = createApiRouter;
