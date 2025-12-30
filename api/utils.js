const axios = require('axios');
const https = require('https');
const { kv } = require('@vercel/kv');
const { ALL_SUPPORTED_REGIONS } = require('./consts'); // 确保你有这个文件，如果没有就忽略这行报错

// 模拟 headers，防反爬
const HTTP = axios.create({
  timeout: 6000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  }
});

// ==========================================
// 🛡️ 核心：限额与VIP检查
// ==========================================
async function checkUsageLimit(openId, action, maxLimit) {
  if (!openId) return true; // 没ID就放行(防止报错)

  // 1. 👑 检查是否为 VIP
  try {
    const isVip = await kv.get(`vip:${openId}`);
    if (isVip) {
      console.log(`[VIP] User ${openId} is VIP. Pass.`);
      return true; // VIP 直接放行
    }
  } catch (e) {
    console.warn('VIP Check Error:', e.message);
  }

  // 2. 普通限额检查
  const today = new Date().toISOString().split('T')[0];
  const key = `limit:${action}:${today}:${openId}`;

  try {
    const current = await kv.get(key);
    const count = current ? parseInt(current) : 0;
    
    if (count >= maxLimit) return false; // 🚫 拦截

    await kv.incr(key); 
    await kv.expire(key, 86400); // 24小时过期
    return true; 
  } catch (e) {
    console.error('KV Error:', e.message);
    return true; // 数据库挂了就默认放行，别卡死用户
  }
}

// ==========================================
// 👮‍♂️ 管理员：VIP 管理
// ==========================================
async function manageVip(command, targetOpenId) {
  if (!targetOpenId) return '❌ 请输入用户 OpenID';
  const vipKey = `vip:${targetOpenId}`;
  
  try {
    if (command === 'add') {
      await kv.set(vipKey, '1'); 
      return `✅ 成功！\n用户 ${targetOpenId}\n已升级为永久 VIP！`;
    } else if (command === 'del') {
      await kv.del(vipKey);
      return `👋 已取消 \n${targetOpenId}\n的 VIP 资格。`;
    }
    return '指令错误：请使用 vip add 或 vip del';
  } catch (e) {
    return `操作失败: ${e.message}`;
  }
}

// ==========================================
// 🛠️ 工具函数 (爬虫/数据处理)
// ==========================================
async function getJSON(url) {
  try {
    const { data } = await HTTP.get(url);
    return data;
  } catch (err) {
    console.error('Fetch JSON Error:', err.message);
    return {}; // 返回空对象防止崩溃
  }
}

async function fetchGdmf() {
  const url = 'https://gdmf.apple.com/v2/pmv';
  const agent = new https.Agent({ rejectUnauthorized: false }); // 忽略证书错误
  try {
    const response = await axios.get(url, { 
      timeout: 5000, 
      httpsAgent: agent,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    return response.data;
  } catch (error) { 
    console.error('GDMF Error:', error.message);
    return null; 
  }
}

function formatPrice(r) {
  if (!r) return '未知';
  if (r.formattedPrice) return r.formattedPrice.replace(/^Free$/i, '免费');
  if (typeof r.price === 'number') return r.price === 0 ? '免费' : `${r.currency || ''} ${r.price.toFixed(2)}`;
  return '未知';
}

function toBeijingYMD(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  const bj = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  return `${bj.getFullYear()}-${String(bj.getMonth()+1).padStart(2,'0')}-${String(bj.getDate()).padStart(2,'0')}`;
}

// 简单的版本收集逻辑
function collectReleases(data, platform) {
  if (!data || !data.PublicAssetSets) return [];
  const releases = [];
  const sets = data.PublicAssetSets.iOS || []; // 默认取 iOS
  
  sets.forEach(item => {
    if (item.ProductVersion && item.PostingDate) {
      releases.push({
        os: 'iOS',
        version: item.ProductVersion,
        build: item.Build,
        date: item.PostingDate
      });
    }
  });
  // 排序：新日期在前
  return releases.sort((a, b) => new Date(b.date) - new Date(a.date));
}

// 导出所有函数
module.exports = {
  checkUsageLimit,
  manageVip,
  getJSON,
  fetchGdmf,
  formatPrice,
  toBeijingYMD,
  collectReleases,
  // 兼容旧代码的占位符
  getCountryCode: (id) => id,
  isSupportedRegion: () => true,
  pickBestMatch: (q, r) => r && r[0],
  determinePlatformsFromDevices: () => new Set(['iOS'])
};
