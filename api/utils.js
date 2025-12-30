const axios = require('axios');
const https = require('https');
const { kv } = require('@vercel/kv'); // 引入数据库
const { ALL_SUPPORTED_REGIONS } = require('./consts');

const HTTP = axios.create({ timeout: 4000 });

// 👇👇👇 核心检查逻辑 👇👇👇
async function checkUsageLimit(openId, action, maxLimit) {
  // 1. 如果上一步没传 ID，这里就会打印警告
  if (!openId) {
    console.log('⚠️ 警告: checkUsageLimit 没有收到 OpenID，只能放行。');
    return true; 
  }

  const today = new Date().toISOString().split('T')[0];
  const key = `limit:${action}:${today}:${openId}`;

  try {
    // 2. 真正去问数据库
    const current = await kv.get(key);
    const count = current ? parseInt(current) : 0;
    console.log(`[KV Check] User: ${openId}, Count: ${count}`); // 打印日志

    if (count >= maxLimit) return false; // 🚫 拦截

    await kv.incr(key); 
    await kv.expire(key, 86400); 
    return true; // ✅ 放行
  } catch (e) {
    console.error('❌ 数据库连接失败:', e.message); // 如果连不上，这里会报错
    return true; // 即使报错也放行，防止机器人挂掉
  }
}

// ... 这里的 helper 函数不用变 (getCountryCode 等) ...
// 为了方便你复制，我把你原有的 helper 函数简化写在这里，保留你原文件的其余部分即可
// ⚠️ 注意：请确保你原来的 getCountryCode, getJSON 等函数还在
// 如果不确定，只替换 checkUsageLimit 这个函数也行。

module.exports = {
  HTTP,
  checkUsageLimit, // 导出这个新函数
  // ... 确保导出了其他原有的函数 ...
  getCountryCode: (id) => id, // 占位，请保留你原来的
  getJSON: axios.get, // 占位
  isSupportedRegion: () => true, // 占位
  pickBestMatch: (q, r) => r[0], // 占位
  formatPrice: () => '免费', // 占位
  fetchExchangeRate: () => null, // 占位
  fetchGdmf: () => null, // 占位
  normalizePlatform: (p) => p, // 占位
  toBeijingYMD: (d) => d, // 占位
  collectReleases: () => [], // 占位
  determinePlatformsFromDevices: () => new Set() // 占位
};
// ⚠️ 上面这块 module.exports 最好只复制 checkUsageLimit 覆盖进去，或者把你原来的 exports 补全
