const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('node:path');
const rateLimit = require('express-rate-limit');
const { createPricing } = require('./pricing');

const DESKTOP_HEADERS = {
  strictTransportSecurity: false,
  contentSecurityPolicy: {
    directives: {
      upgradeInsecureRequests: null,
      connectSrc: ["'self'", 'ws://127.0.0.1:4301', 'https://daily-analytics.sr-architect.workers.dev'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://github.com', 'https://avatars.githubusercontent.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    },
  },
};

function configureDesktopRoutes(app, { staticDir }) {
  app.use('/api', (_req, res) => res.status(404).json({ message: 'API route not found.' }));
  app.use(express.static(staticDir));
  // Mirror the SPA entry routes. Missing assets should get a regular 404.
  app.get(['/', '/playground', '/docs', '/reports', '/benchmarks'], (_req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
  });
}

function configureWebCors(app) {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:4200')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origin ${origin} is not allowed by CORS.`));
    },
  }));
}

function createApp({ desktop } = {}) {
  const app = express();
  const pricing = createPricing({ pricingFile: desktop?.pricingFile });

  app.use(helmet(desktop ? DESKTOP_HEADERS : undefined));
  if (desktop) {
    app.use((req, res, next) => {
      if (req.headers.host !== desktop.hostHeader) {
        return res.status(403).json({ message: 'Invalid host.' });
      }
      next();
    });
  } else {
    configureWebCors(app);
  }
  app.use(express.json());
  app.use('/api', rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
  }));

  app.get('/api/prices', async (req, res) => {
    const { status, cache, body } = await pricing.prices(req.query.region);
    if (cache) res.setHeader('X-Cache', cache);
    res.status(status).json(body);
  });

  app.get('/api/status', (_req, res) => {
    const { status, body } = pricing.status();
    res.status(status).json(body);
  });

  if (desktop) configureDesktopRoutes(app, desktop);
  return app;
}

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
  const port = process.env.PORT || 3000;
  createApp().listen(port, process.env.BIND_HOST, () => {
    console.log(`[server] 🚀 Pricing backend listening on port ${port}`);
  });
}

module.exports = { createApp };
