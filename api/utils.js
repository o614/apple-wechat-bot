// api/utils.js
const axios = require('axios');
const https = require('https');
const { kv } = require('@vercel/kv');
const { ALL_SUPPORTED_REGIONS, DAILY_REQUEST_LIMIT, ADMIN_OPENID } = require('./consts');

const SOURCE_NOTE = '*数据来源 Apple 官方*';

const HTTP = axios.create({
  timeout: 4000, 
  headers: { 'user-agent': 'Mozilla/5.0 (Serverless-WeChatBot)' }
});

// ----------------------
// 缓存与限流
// ----------------------

async function withCache(key, ttl, fetcher) {
  if (!process.env.KV_REST_API_TOKEN) return await fetcher();
  try {
    const cached = await kv.get(key);
    if (cached) return cached;
  } catch (e) { console.warn('KV Get Error:', e.message); }

  const data = await fetcher();
  if (data) {
    try { await kv.set(key, data, { ex: ttl }); } catch (e) {}
  }
  return data;
}

// 检查图片链接是否有效 (HEAD 请求)
async function checkUrlAccessibility(url) {
  try {
    await HTTP.head(url, { timeout: 1500 });
    return true;
  } catch (e) { return false; }
}

// 用户限流检查
async function checkUserRateLimit(openid) {
  // 无 KV 或管理员,直接放行
  if (!process.env.KV_REST_API_TOKEN || openid === ADMIN_OPENID) return true;

  const key = `limit:req:${openid}`;
  try {
    const currentCount = await kv.incr(key);
    if (currentCount === 1) await kv.expire(key, 86400); // 24小时过期
    return currentCount <= DAILY_REQUEST_LIMIT;
  } catch (e) { 
    return true; // KV 故障时不阻断业务
  }
}

// ----------------------
// 业务工具
// ----------------------

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 【核心修复】获取地区代码 (支持中文名和代码)
function getCountryCode(identifier) {
  const cleanKey = String(identifier || '').trim().toLowerCase();
  return ALL_SUPPORTED_REGIONS[cleanKey] || '';
}

// 【新增】根据代码获取中文名称
function getCountryName(code) {
  // 从 ALL_SUPPORTED_REGIONS 中反向查找中文名
  for (const [name, c] of Object.entries(ALL_SUPPORTED_REGIONS)) {
    if (c === code && name.length > 2) { // 长度>2说明是中文名,不是代码
      return name;
    }
  }
  return code; // 找不到就返回代码本身
}

function isSupportedRegion(identifier) {
  return !!getCountryCode(identifier);
}

function getFormattedTime() {
  const now = new Date();
  const bj = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const yyyy = String(bj.getFullYear());
  const mm = String(bj.getMonth() + 1).padStart(2, '0');
  const dd = String(bj.getDate()).padStart(2, '0');
  const hh = String(bj.getHours()).padStart(2, '0');
  const mi = String(bj.getMinutes()).padStart(2, '0');
  return `${yyyy.slice(-2)}/${mm}/${dd} ${hh}:${mi}`;
}

async function getJSON(url) {
  return HTTP.get(url).then(res => res.data);
}

function pickBestMatch(query, results) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return results[0];
  const exact = results.find(r => String(r.trackName || '').toLowerCase() === q);
  return exact || results.find(r => String(r.trackName || '').toLowerCase().includes(q)) || results[0];
}

function formatPrice(r) {
  if (r.formattedPrice) return r.formattedPrice.replace(/^Free$/i, '免费');
  if (typeof r.price === 'number') {
    return r.price === 0 ? '免费' : `${r.currency || ''} ${r.price.toFixed(2)}`.trim();
  }
  return '未知';
}

async function fetchExchangeRate(targetCurrencyCode) {
  if (!targetCurrencyCode || targetCurrencyCode.toUpperCase() === 'CNY') return null;
  try {
    const url = `https://api.frankfurter.app/latest?from=${targetCurrencyCode.toUpperCase()}&to=CNY`;
    const { data } = await axios.get(url, { timeout: 2500 });
    return data?.rates?.CNY || null;
  } catch (e) { return null; }
}

async function fetchGdmf() {
  const url = 'https://gdmf.apple.com/v2/pmv';
  const headers = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };
  const agent = new https.Agent({ rejectUnauthorized: false });
  try {
    const response = await HTTP.get(url, { headers, httpsAgent: agent });
    if (!response.data || typeof response.data !== 'object') throw new Error('Invalid GDMF data');
    return response.data;
  } catch (error) { throw new Error('fetchGdmf Error'); }
}

function normalizePlatform(p) {
  const k = String(p || '').toLowerCase();
  if (['ios','iphoneos','iphone'].includes(k)) return 'iOS';
  if (['ipados','ipad'].includes(k)) return 'iPadOS';
  if (['macos','mac','osx'].includes(k)) return 'macOS';
  if (['watchos','watch'].includes(k)) return 'watchOS';
  if (['tvos','apple tv','tv'].includes(k)) return 'tvOS';
  if (['visionos','vision'].includes(k)) return 'visionOS';
  return null;
}

function toBeijingYMD(s) {
  if (!s) return '';
  const d = new Date(s); if (isNaN(d)) return '';
  const bj = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const y = bj.getFullYear(), m = String(bj.getMonth()+1).padStart(2,'0'), d2 = String(bj.getDate()).padStart(2,'0');
  return `${y}-${m}-${d2}`;
}

// 短日期格式 25/12/15
function toBeijingShortDate(s) {
  if (!s) return '';
  const d = new Date(s); if (isNaN(d)) return '';
  const bj = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const y = String(bj.getFullYear()).slice(-2);
  const m = String(bj.getMonth()+1).padStart(2,'0');
  const d2 = String(bj.getDate()).padStart(2,'0');
  return `${y}/${m}/${d2}`;
}

function collectReleases(data, platform) {
  const releases = [];
  const targetOS = normalizePlatform(platform);
  if (!targetOS || !data) return releases;
  const assetSetNames = ['PublicAssetSets', 'AssetSets'];
  const foundBuilds = new Set();

  for (const setName of assetSetNames) {
    const assetSet = data[setName];
    if (assetSet && typeof assetSet === 'object') {
      for (const sourceKey in assetSet) {
          const platformArray = assetSet[sourceKey];
          if (platformArray && Array.isArray(platformArray)) {
              platformArray.forEach(node => {
                  if (node && typeof node === 'object') {
                      const version = node.ProductVersion || node.OSVersion || node.SystemVersion;
                      const build = node.Build || node.BuildID || node.BuildVersion;
                      const dateStr = node.PostingDate || node.ReleaseDate || node.Date;
                      const devices = node.SupportedDevices;
                      if (version && build && !foundBuilds.has(build)) {
                          const actualPlatforms = determinePlatformsFromDevices(devices);
                          if (actualPlatforms.has(targetOS)) {
                              releases.push({ os: targetOS, version, build, date: dateStr, raw: node });
                              foundBuilds.add(build);
                          } else if (targetOS === 'iPadOS' && actualPlatforms.has('iOS')) {
                             if (parseFloat(version) >= 13.0) {
                                  releases.push({ os: targetOS, version, build, date: dateStr, raw: node });
                                  foundBuilds.add(build);
                             }
                          }
                      }
                  }
              });
          }
      }
    }
  }
  return releases;
}

function determinePlatformsFromDevices(devices) {
    const platforms = new Set();
    if (!Array.isArray(devices)) return platforms;
    for (const device of devices) {
        const d = String(device || '').toLowerCase();
        if (d.startsWith('iphone') || d.startsWith('ipod')) platforms.add('iOS');
        else if (d.startsWith('ipad')) platforms.add('iPadOS');
        else if (d.startsWith('watch')) platforms.add('watchOS');
        else if (d.startsWith('appletv')) platforms.add('tvOS');
        else if (d.includes('mac')) platforms.add('macOS');
        else if (d.startsWith('realitydevice')) platforms.add('visionOS');
    }
    return platforms;
}

module.exports = {
  HTTP, SOURCE_NOTE, withCache, formatBytes, getCountryCode, getCountryName, isSupportedRegion,
  getFormattedTime, getJSON, pickBestMatch, formatPrice, fetchExchangeRate, fetchGdmf,
  normalizePlatform, toBeijingYMD, toBeijingShortDate, collectReleases, 
  checkUrlAccessibility, checkUserRateLimit
};
