module.exports = {
  apps: [
    {
      name: "nl-backend",
      script: "src/index.js",
      cwd: "/opt/NL/backend",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 3000,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
