const express = require('express');
const cors = require('cors');

const createApiRouter = require('./routes/api');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get('/', (req, res) => {
    res.json({
      status: 'ok',
      service: 'Madrastna Enterprise API v3',
      timestamp: new Date().toISOString(),
    });
  });

  app.use('/api', createApiRouter());
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = {
  createApp,
};
