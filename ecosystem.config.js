'use strict';

module.exports = {
  apps: [{
    name:               'akta-iat',
    script:             'server.js',
    instances:          'max',
    exec_mode:          'cluster',
    watch:              false,
    max_memory_restart: '500M',

    env: {
      NODE_ENV: 'production',
      PORT:     3000,
    },
    env_development: {
      NODE_ENV: 'development',
      PORT:     3000,
    },

    error_file:      'logs/pm2-error.log',
    out_file:        'logs/pm2-output.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs:      true,

    restart_delay: 3000,
    max_restarts:  10,
    min_uptime:    '10s',
  }],
};
