module.exports = {
  apps: [
    {
      name: 'seo-dashboard',
      script: 'agents/dashboard/index.js',
      args: '--port 4242 --public',
      interpreter: 'node',
      cwd: '/root/seo-claude',
      restart_delay: 5000,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
