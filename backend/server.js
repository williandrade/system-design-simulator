const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const fs = require('node:fs');
const path = require('node:path');
const rateLimit = require('express-rate-limit');
const { SUPPORTED_REGIONS } = require('./regions');

const DEFAULT_PRICING_FILE = path.join(
  __dirname, '..', 'frontend', 'src', 'app', 'core', 'data', 'regions', 'us-east-1.json',
);
const MEM_CACHE_TTL_MS = 60 * 60 * 1000;

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
  const pricingFile = desktop?.pricingFile ?? DEFAULT_PRICING_FILE;
  const accountId = process.env.CF_ACCOUNT_ID || '';
  const namespaceId = process.env.CF_KV_NAMESPACE_ID || '';
  const apiToken = process.env.CF_API_TOKEN || '';
  const kvConfigured = [accountId, namespaceId, apiToken]
    .every((value) => value && !value.startsWith('REPLACE_'));
  const kvBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values`;
  const memCache = new Map();

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

  async function getPricingFromKV(regionCode) {
    const cached = memCache.get(regionCode);
    if (cached && (Date.now() - cached.cachedAt) < MEM_CACHE_TTL_MS) {
      console.log(`[server] 🟢 Memory cache HIT for: ${regionCode}`);
      return cached.data;
    }

    if (!kvConfigured) {
      console.warn('[server] ⚠️  Cloudflare KV credentials not configured or placeholder in .env.');
      return null;
    }

    const kvKey = `pricing:${regionCode}`;
    const url = `${kvBase}/${encodeURIComponent(kvKey)}`;
    console.log(`[server] 🔵 Fetching from Cloudflare KV: ${kvKey}`);

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${apiToken}` },
      });

      if (response.status === 404) {
        console.warn(`[server] ⚠️  Region not found in KV: ${regionCode} — this region has not been generated yet.`);
        return null;
      }

      if (!response.ok) {
        console.error(`[server] ❌ KV API error ${response.status} for ${regionCode}.`);
        return null;
      }

      const data = await response.json();
      memCache.set(regionCode, { data, cachedAt: Date.now() });
      console.log(`[server] ✅ Showing pricing for region: ${regionCode} (source: Cloudflare KV)`);
      return data;
    } catch {
      console.error(`[server] ❌ Failed to load Cloudflare KV pricing for ${regionCode}.`);
      return null;
    }
  }

  app.get('/api/prices', async (req, res) => {
    const { region } = req.query;
    if (region !== undefined && typeof region !== 'string') {
      return res.status(400).json({ message: 'The region query parameter must be a single string.' });
    }
    const regionCode = (region || 'us-east-1').trim().toLowerCase();

    if (!SUPPORTED_REGIONS.has(regionCode)) {
      return res.status(404).json({
        unsupportedRegion: true,
        regionCode,
        message: `Region "${regionCode}" is not a recognized AWS region code.`,
      });
    }

    if (regionCode === 'us-east-1' && fs.existsSync(pricingFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(pricingFile, 'utf8'));
        res.setHeader('X-Cache', 'LOCAL_FILE');
        return res.json(data);
      } catch (err) {
        console.error('[server] ❌ Error reading local us-east-1.json file:', err.message);
      }
    }

    const data = await getPricingFromKV(regionCode);
    if (data === null) {
      const message = kvConfigured
        ? `Pricing for region "${regionCode}" has not been generated yet. The Worker generates all regions weekly.`
        : 'Cloudflare KV credentials not configured, and requested region is not us-east-1.';
      return res.status(404).json({ unsupportedRegion: true, regionCode, message });
    }

    res.setHeader('X-Cache', 'KV');
    res.json(data);
  });

  app.get('/api/status', (_req, res) => {
    res.json({ cachedRegions: [...memCache.keys()], kvConfigured });
  });

  if (desktop) configureDesktopRoutes(app, desktop);
  return app;
}

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
  const port = process.env.PORT || 3000;
  createApp().listen(port, () => {
    console.log(`[server] 🚀 Pricing backend listening on port ${port}`);
  });
}

module.exports = { createApp };
