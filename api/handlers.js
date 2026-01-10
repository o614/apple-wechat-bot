// api/handlers.js
const { 
  getCountryCode, getCountryName, getJSON, getFormattedTime, SOURCE_NOTE, 
  pickBestMatch, formatPrice, fetchExchangeRate, 
  fetchGdmf, collectReleases, normalizePlatform, toBeijingYMD,
  checkUrlAccessibility, toBeijingShortDate, formatBytes, withCache
} = require('./utils');

const { DSF_MAP, BLOCKED_APP_IDS, ADMIN_OPENID, DAILY_REQUEST_LIMIT } = require('./consts');

let kv = null;
try { ({ kv } = require('@vercel/kv')); } catch (e) { kv = null; }

const CACHE_TTL_SHORT = 600; 
const CACHE_TTL_LONG = 1800; 

// 1. 榜单查询 (【最终版】双接口自动切换 + 智能超时控制)
async function handleChartQuery(regionInput, chartType) {
  const regionCode = getCountryCode(regionInput);
  if (!regionCode) return '不支持的地区或格式错误。';

  const displayName = getCountryName(regionCode);
  const interactiveName = displayName || regionInput;
  
  // 【修改】缓存前缀 v7
  const cacheKey = `v7:chart:${regionCode}:${chartType === '免费榜' ? 'free' : 'paid'}`;

  return await withCache(cacheKey, CACHE_TTL_SHORT, async () => {
    // 准备两套方案
    const isFree = chartType === '免费榜';
    
    // 方案A：旧接口 (数据全，但容易超时)
    const typeOld = isFree ? 'topfreeapplications' : 'toppaidapplications';
    const urlOld = `https://itunes.apple.com/${regionCode}/rss/${typeOld}/limit=10/json`;
    
    // 方案B：新接口 (速度快，用作备胎)
    const typeNew = isFree ? 'top-free' : 'top-paid';
    const urlNew = `https://rss.marketingtools.apple.com/api/v2/${regionCode}/apps/${typeNew}/10/apps.json`;

    let apps = [];
    let usedSource = 'old';

    try {
      // 1. 尝试旧接口 (设置 2.5秒 超时，快速失败)
      // 注意：这里需要 getJSON 支持自定义 timeout，如果没有传，默认是 8秒，会导致微信超时无回复
      const dataOld = await getJSON(urlOld, { timeout: 2500 });
      const entries = (dataOld && dataOld.feed && dataOld.feed.entry) || [];
      if (entries.length) {
         // 解析旧数据格式
         apps = entries.map(e => {
            let u = '';
            if (e.link) {
               if (Array.isArray(e.link)) u = (e.link[0] && e.link[0].attributes) ? e.link[0].attributes.href : '';
               else if (e.link.attributes) u = e.link.attributes.href;
            }
            return {
               id: e.id && e.id.attributes ? e.id.attributes['im:id'] : '',
               name: e['im:name'] ? e['im:name'].label : '未知应用',
               url: u
            };
         });
      } else {
         throw new Error('Old API empty');
      }
    } catch (e) {
      // 2. 旧接口失败/超时，降级使用新接口
      console.log(`Switching to New API for ${regionCode}: ${e.message}`);
      try {
         usedSource = 'new';
         const dataNew = await getJSON(urlNew, { timeout: 3000 });
         const results = (dataNew && dataNew.feed && dataNew.feed.results) || [];
         if (results.length) {
            // 解析新数据格式
            apps = results.map(r => ({
               id: r.id,
               name: r.name,
               url: r.url
            }));
         }
      } catch (errNew) {
         console.error('Both APIs failed:', errNew.message);
         return '获取榜单失败，Apple 接口暂时不可用。';
      }
    }

    if (!apps.length) return '获取榜单失败，暂无数据。';

    // 3. 渲染结果
    let resultText = `${interactiveName}${chartType}\n${getFormattedTime()}\n\n`;
    
    resultText += apps.map((app, idx) => {
      const appId = String(app.id || '');
      const appName = app.name || '未知应用';
      
      if (BLOCKED_APP_IDS.has(appId)) return `${idx + 1}、${appName}`;
      return app.url ? `${idx + 1}、<a href="${app.url}">${appName}</a>` : `${idx + 1}、${appName}`;
    }).join('\n');

    const toggleCmd = chartType === '免费榜' ? `${interactiveName}付费榜` : `${interactiveName}免费榜`;
    
    resultText += `\n› <a href="weixin://bizmsgmenu?msgmenucontent=${encodeURIComponent(toggleCmd)}&msgmenuid=chart_toggle">查看${chartType === '免费榜' ? '付费' : '免费'}榜单</a>`;
    resultText += `\n\n${SOURCE_NOTE}`;
    return resultText;
  });
}

// 2. 价格查询 (limit=1 + 强制刷新缓存)
async function handlePriceQuery(appName, regionName, isDefaultSearch) {
  const code = getCountryCode(regionName);
  if (!code) return `不支持的地区或格式错误：${regionName}`;

  // 【关键修改】缓存前缀 v4
  const cacheKey = `v4:price:${code}:${appName.toLowerCase().replace(/\s/g, '')}`;

  return await withCache(cacheKey, CACHE_TTL_SHORT, async () => {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(appName)}&entity=software&country=${code}&limit=1`;
    try {
      const data = await getJSON(url);
      const results = data.results || [];
      if (!results.length) return `在${regionName}未找到“${appName}”。`;

      const best = results[0];
      const link = `<a href="${best.trackViewUrl}">${best.trackName}</a>`;
      const priceText = formatPrice(best);

      let replyText = `您查询的“${appName}”最匹配的结果是：\n\n${link}\n\n地区：${regionName}\n价格：${priceText}`;
      if (typeof best.price === 'number' && best.price > 0 && best.currency) {
        const rate = await fetchExchangeRate(best.currency);
        if (rate) {
          const cnyPrice = (best.price * rate).toFixed(2);
          replyText += ` (≈ ¥${cnyPrice})`;
        }
      }
      replyText += `\n时间：${getFormattedTime()}`;
      if (isDefaultSearch) replyText += `\n\n想查其他地区？试试发送：\n价格 ${appName} 日本`;
      return replyText + `\n\n${SOURCE_NOTE}`;
    } catch (e) {
      return '查询价格失败，请稍后再试。';
    }
  });
}

// 3. 商店切换 (保持混合方案)
function handleRegionSwitch(regionName) {
  const regionCode = getCountryCode(regionName);
  const dsf = DSF_MAP[regionCode];
  if (!regionCode || !dsf) return '不支持的地区或格式错误。';
  
  const stableAppId = '375380948';
  const redirectPath = `/WebObjects/MZStore.woa/wa/viewSoftware?mt=8&id=${stableAppId}`;
  
  const fullUrl = `https://itunes.apple.com/WebObjects/MZStore.woa/wa/resetAndRedirect?dsf=${dsf}&cc=${regionCode}&url=${encodeURIComponent(redirectPath)}`;
  const rawUrl = `itms-apps://itunes.apple.com/WebObjects/MZStore.woa/wa/resetAndRedirect?dsf=${dsf}&cc=${regionCode}`;

  const cnCode = 'cn';
  const cnDsf = DSF_MAP[cnCode];
  const cnUrl = `https://itunes.apple.com/WebObjects/MZStore.woa/wa/resetAndRedirect?dsf=${cnDsf}&cc=${cnCode}&url=${encodeURIComponent(redirectPath)}`;
  const cnRawUrl = `itms-apps://itunes.apple.com/WebObjects/MZStore.woa/wa/resetAndRedirect?dsf=${cnDsf}&cc=${cnCode}`;

  return `注意！仅浏览，需账号才能下载\n*出现“无法连接”后将自动跳转\n\n` +
         `› <a href="${fullUrl}">点击切换至【${regionName}】 App Store</a>\n\n` +
         `› 点此切换至 <a href="${cnUrl}">【大陆】</a> App Store\n\n` +
         `备用（请长按复制到 Safari 打开）\n\n` +
         `${regionName}：\n<a href="weixin://">${rawUrl}</a>\n\n` +
         `中国：\n<a href="weixin://">${cnRawUrl}</a>`;
}

// 4. 应用详情 (强制刷新缓存)
async function handleAppDetails(appName) {
  const code = 'us';
  // 【关键修改】缓存前缀 v4
  const cacheKey = `v4:detail:us:${appName.toLowerCase().replace(/\s/g, '')}`;

  return await withCache(cacheKey, CACHE_TTL_SHORT, async () => {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(appName)}&entity=software&country=${code}&limit=1`;
    try {
      const data = await getJSON(url);
      if (!data || !data.results || data.results.length === 0) {
        return `未找到应用“${appName}”，请检查名称或稍后再试。`;
      }
      const app = data.results[0];
      const rating = app.averageUserRating ? app.averageUserRating.toFixed(1) : '暂无';
      const size = formatBytes(app.fileSizeBytes || 0);
      const updateDate = toBeijingShortDate(app.currentVersionReleaseDate); 
      const minOS = app.minimumOsVersion ? `${app.minimumOsVersion}+` : '未知';

      let reply = `您查询的“${appName}”最匹配的结果是：\n\n`;
      reply += `<a href="${app.trackViewUrl}">${app.trackName}</a>\n\n`; 
      reply += `评分：${rating}\n`;
      reply += `大小：${size}\n`;
      reply += `更新：${updateDate}\n`;
      reply += `版本：${app.version}\n`;
      reply += `兼容：iOS ${minOS}\n`;
      reply += `\n${SOURCE_NOTE}`;
      return reply;
    } catch (e) {
      console.error('App Detail Error:', e);
      return '获取应用详情失败，请稍后再试。';
    }
  });
}

// 5. 图标查询 (强制刷新缓存)
async function lookupAppIcon(appName) {
  // 【关键修改】缓存前缀 v4
  const cacheKey = `v4:icon:us:${appName.toLowerCase().replace(/\s/g, '')}`;
  return await withCache(cacheKey, CACHE_TTL_SHORT, async () => {
    try {
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(appName)}&country=us&entity=software&limit=1`;
      const data = await getJSON(url);
      if (data.resultCount === 0) return '未找到相关应用，请检查名称。';
      const app = data.results[0];
      const highRes = String(app.artworkUrl100 || '').replace('100x100bb.jpg', '1024x1024bb.jpg');
      
      let finalIcon = app.artworkUrl512 || app.artworkUrl100;
      let desc = '图标链接';
      
      if (highRes && highRes !== app.artworkUrl100) {
          if (await checkUrlAccessibility(highRes)) {
            finalIcon = highRes;
            desc = '高清图标链接';
          }
      }
      
      const appLink = `<a href="${app.trackViewUrl}">${app.trackName}</a>`;
      return `您查询的“${appName}”最匹配的结果是：\n\n${appLink}\n\n这是它的${desc}：\n${finalIcon}\n\n${SOURCE_NOTE}`;
    } catch (e) {
      return '查询应用图标失败，请稍后再试。';
    }
  });
}

// 6. 系统更新 (强制刷新缓存)
async function handleSimpleAllOsUpdates() {
  // 【关键修改】缓存前缀 v4
  const cacheKey = `v4:os:simple_all`;
  return await withCache(cacheKey, CACHE_TTL_LONG, async () => {
    try {
      const data = await fetchGdmf();
      const platforms = ['iOS','iPadOS','macOS','watchOS','tvOS','visionOS'];
      const results = [];
      for (const p of platforms) {
        const list = collectReleases(data, p);
        if (list.length) {
          const latest = list.sort((a,b)=>b.version.localeCompare(a.version,undefined,{numeric:true}))[0];
          results.push(`• ${p} ${latest.version}`);
        }
      }
      if (!results.length) return '暂未获取到系统版本信息，请稍后再试。';
      
      let replyText = `最新系统版本：\n\n${results.join('\n')}\n\n查看详情：\n`;
      replyText += `› <a href="weixin://bizmsgmenu?msgmenucontent=更新iOS&msgmenuid=iOS">iOS</a>      › <a href="weixin://bizmsgmenu?msgmenucontent=更新iPadOS&msgmenuid=iPadOS">iPadOS</a>\n`;
      replyText += `› <a href="weixin://bizmsgmenu?msgmenucontent=更新macOS&msgmenuid=macOS">macOS</a>     › <a href="weixin://bizmsgmenu?msgmenucontent=更新watchOS&msgmenuid=watchOS">watchOS</a>\n`;
      replyText += `\n查询时间：${getFormattedTime()}\n\n${SOURCE_NOTE}`;
      
      return replyText;
    } catch (e) {
      return '查询系统版本失败，请稍后再试。';
    }
  });
}

async function handleDetailedOsUpdate(inputPlatform = 'iOS') {
  const platform = normalizePlatform(inputPlatform) || 'iOS';
  // 【关键修改】缓存前缀 v4
  const cacheKey = `v4:os:detail:${platform}`;
  return await withCache(cacheKey, CACHE_TTL_LONG, async () => {
    try {
      const data = await fetchGdmf();
      const list = collectReleases(data, platform);
      if (!list.length) return `${platform} 暂无版本信息。`;

      list.sort((a,b)=>{
        const da = new Date(a.date||0), db = new Date(b.date||0);
        if (db - da !== 0) return db - da;
        return b.version.localeCompare(a.version,undefined,{numeric:true});
      });

      const latest = list[0];
      const stableTag = /beta|rc|seed/i.test(JSON.stringify(latest.raw)) ? '' : ' — 正式版';
      const latestDateStr = toBeijingShortDate(latest.date) || '未知';

      const lines = list.slice(0,5).map(r=>{
        const t = toBeijingShortDate(r.date);
        const releaseTag = /beta/i.test(JSON.stringify(r.raw)) ? ' (Beta)' : '';
        return `• ${r.version} (${r.build})${releaseTag}${t?` ${t}`:''}`;
      });

      return `${platform} 最新版本：\n版本：${latest.version}（${latest.build}）${stableTag}\n时间：${latestDateStr}\n\n近期历史：\n${lines.join('\n')}\n\n${SOURCE_NOTE}`;
    } catch (e) {
      return '查询系统版本失败，请稍后再试。';
    }
  });
}

// 7. 管理后台
async function handleAdminStatus(fromUser) {
  if (fromUser !== ADMIN_OPENID) return ''; 
  try {
    const dbSize = kv ? await kv.dbsize() : '未连接KV'; 
    return `【管理看板】\n\n状态：运行中\n缓存Key数：${dbSize}\n每日限额：${DAILY_REQUEST_LIMIT}次/人\n\n系统时间：${getFormattedTime()}`;
  } catch (e) {
    return `后台查询出错：${e.message}`;
  }
}

module.exports = {
  handleChartQuery, handlePriceQuery, handleRegionSwitch, handleAppDetails,
  lookupAppIcon, handleSimpleAllOsUpdates, handleDetailedOsUpdate, handleAdminStatus
};
