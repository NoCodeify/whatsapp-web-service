module.exports = {
  apps: [
    {
      name: "whatsapp-web-service",
      script: "./dist/server.js",
      instances: 1,
      exec_mode: "cluster",

      // Auto-restart configuration
      max_restarts: 10,
      min_uptime: "10s",
      max_memory_restart: "1G",
      autorestart: true,
      watch: false,

      // Exponential backoff for restarts
      restart_delay: 4000,
      exp_backoff_restart_delay: 100,

      // Environment variables
      env: {
        NODE_ENV: "production",
        PORT: 8090,

        // Session storage
        SESSION_STORAGE_TYPE: "hybrid",
        SESSION_BACKUP_INTERVAL: "60000",

        // Health monitoring
        HEALTH_CHECK_INTERVAL: "30000",
        AUTO_RECOVERY: "true",

        // Resource limits
        MAX_CONNECTIONS: "50",
        MEMORY_THRESHOLD: "0.85",
        CPU_THRESHOLD: "80",
      },

      env_development: {
        NODE_ENV: "development",
        PORT: 8090,
        SESSION_STORAGE_TYPE: "local",
        USE_PROXY: "false",
        LOG_LEVEL: "debug",
      },

      env_staging: {
        NODE_ENV: "staging",
        PORT: 8090,
        SESSION_STORAGE_TYPE: "hybrid",
        SESSION_BACKUP_INTERVAL: "120000",
      },

      // Logging
      error_file: "./logs/error.log",
      out_file: "./logs/out.log",
      merge_logs: true,
      time: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",

      // Advanced features
      kill_timeout: 30000,
      listen_timeout: 10000,
      shutdown_with_message: true,

      // Monitoring
      instance_var: "INSTANCE_ID",

      // Graceful reload
      wait_ready: true,

      // Error handling
      post_update: ["npm install"],

      // Lifecycle hooks
      pre_restart_delay: 1000,
    },
  ],

  // Deploy configuration (optional)
  deploy: {
    production: {
      user: "deploy",
      host: "your-server.com",
      ref: "origin/main",
      repo: "git@github.com:your-org/whatsapp-web-service.git",
      path: "/var/www/whatsapp-web-service",
      "pre-deploy-local": "",
      "post-deploy":
        "npm install && npm run build && pm2 reload ecosystem.config.js --env production",
      "pre-setup": "",
    },

    staging: {
      user: "deploy",
      host: "staging-server.com",
      ref: "origin/develop",
      repo: "git@github.com:your-org/whatsapp-web-service.git",
      path: "/var/www/whatsapp-web-service-staging",
      "post-deploy":
        "npm install && npm run build && pm2 reload ecosystem.config.js --env staging",
    },
  },
};
