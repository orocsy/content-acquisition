const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const courseName = process.env.COURSE_NAME || 'educative-course';

module.exports = {
  apps: [
    {
      name: process.env.PM2_APP_NAME || courseName,
      script: path.join(ROOT, 'scripts/run-educative-course.sh'),
      interpreter: '/bin/zsh',
      cwd: ROOT,
      autorestart: true,
      max_restarts: 50,
      min_uptime: '30s',
      restart_delay: 15000,
      exp_backoff_restart_delay: 100,
      time: true,
      env: {
        NODE_ENV: 'production',
        COURSE_NAME: courseName,
        COURSE_URL: process.env.COURSE_URL,
        OUT_DIR: process.env.OUT_DIR,
        CONTENT_ACQUISITION_OUT_DIR: process.env.CONTENT_ACQUISITION_OUT_DIR,
        PM2_APP_NAME: process.env.PM2_APP_NAME,
      }
    }
  ]
};
