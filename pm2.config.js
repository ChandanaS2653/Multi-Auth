module.exports = {
  apps: [
    {
      name: "multiauth",
      script: "server.js",
      instances: 1,
      exec_mode: "fork",
      env_production: {
        NODE_ENV: "production",
        PORT: 5000,
      },
      // Restart on file changes in production is OFF — Jenkins handles restarts
      watch: false,
      // Restart app if it uses more than 512MB (memory leak guard)
      max_memory_restart: "512M",
      // Log files on the server
      out_file: "/var/log/multiauth/out.log",
      error_file: "/var/log/multiauth/error.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      // Wait 5s before restarting on crash — prevents rapid restart loops
      restart_delay: 5000,
      max_restarts: 5,
      min_uptime: "10s",
    },
  ],
};
