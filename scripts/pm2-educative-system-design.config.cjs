const path = require('path');
const ROOT = path.resolve(__dirname, '..');

module.exports = {
  apps: [
    {
      name: 'educative-system-design',
      script: path.join(ROOT, 'scripts/run-educative-system-design.sh'),
      interpreter: '/bin/zsh',
      cwd: ROOT,
      autorestart: true,
      max_restarts: 50,
      min_uptime: '30s',
      restart_delay: 15000,
      exp_backoff_restart_delay: 100,
      time: true,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
