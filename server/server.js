require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const routes = require('./routes');
const { resolvePublicDir, resolvePublicAsset } = require('./runtime-paths');

function createApp() {
  const app = express();
  const publicDir = resolvePublicDir();

  // ── Security ──────────────────────────────────────────────────────────
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors());

  // ── Rate limiting (per-IP) ────────────────────────────────────────────
  app.use('/api/tailor', rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: { error: 'Too many tailoring requests. Wait a moment.' },
  }));

  // ── Body parsing ──────────────────────────────────────────────────────
  app.use(express.json({ limit: '10mb' }));

  // ── Static files ──────────────────────────────────────────────────────
  app.use(express.static(publicDir));

  // ── API routes ────────────────────────────────────────────────────────
  app.use('/api', routes);

  // ── SPA fallback ──────────────────────────────────────────────────────
  app.get('*', (req, res) => {
    res.sendFile(resolvePublicAsset('index.html'));
  });

  return app;
}

function logServerStart(port) {
  console.log(`\n  ╔═══════════════════════════════════════╗`);
  console.log(`  ║   CV Customizer running on port ${port}  ║`);
  console.log(`  ║   http://localhost:${port}              ║`);
  console.log(`  ╚═══════════════════════════════════════╝\n`);
}

function startServer(port = process.env.PORT || 3000) {
  const app = createApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      const actualPort = server.address().port;
      logServerStart(actualPort);
      resolve({ app, server, port: actualPort });
    });
    server.on('error', reject);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { createApp, startServer };
