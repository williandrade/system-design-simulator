const fs = require('node:fs');
const path = require('node:path');
const { SUPPORTED_REGIONS } = require('./regions');

const DEFAULT_PRICING_FILE = path.join(
  __dirname, '..', 'frontend', 'src', 'app', 'core', 'data', 'regions', 'us-east-1.json',
);
const MEM_CACHE_TTL_MS = 60 * 60 * 1000;

function createPricing({ pricingFile = DEFAULT_PRICING_FILE } = {}) {
  const accountId = process.env.CF_ACCOUNT_ID || '';
  const namespaceId = process.env.CF_KV_NAMESPACE_ID || '';
  const apiToken = process.env.CF_API_TOKEN || '';
  const kvConfigured = [accountId, namespaceId, apiToken]
    .every((value) => Boolean(value) && !value.startsWith('REPLACE_'));
  const kvBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values`;
  const memCache = new Map();

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

  async function prices(region) {
    if (region !== undefined && typeof region !== 'string') {
      return { status: 400, body: { message: 'The region query parameter must be a single string.' } };
    }
    const regionCode = (region || 'us-east-1').trim().toLowerCase();

    if (!SUPPORTED_REGIONS.has(regionCode)) {
      return { status: 404, body: {
        unsupportedRegion: true,
        regionCode,
        message: `Region "${regionCode}" is not a recognized AWS region code.`,
      } };
    }

    if (regionCode === 'us-east-1' && fs.existsSync(pricingFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(pricingFile, 'utf8'));
        return { status: 200, cache: 'LOCAL_FILE', body: data };
      } catch (err) {
        console.error('[server] ❌ Error reading local us-east-1.json file:', err.message);
      }
    }

    const data = await getPricingFromKV(regionCode);
    if (data === null) {
      const message = kvConfigured
        ? `Pricing for region "${regionCode}" has not been generated yet. The Worker generates all regions weekly.`
        : 'Cloudflare KV credentials not configured, and requested region is not us-east-1.';
      return { status: 404, body: { unsupportedRegion: true, regionCode, message } };
    }

    return { status: 200, cache: 'KV', body: data };
  }

  function status() {
    return { status: 200, body: { cachedRegions: [...memCache.keys()], kvConfigured } };
  }

  return { prices, status };
}

module.exports = { createPricing };
