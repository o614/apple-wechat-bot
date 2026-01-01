// api/handlers.js
const { 
  getCountryCode, getJSON, getFormattedTime, SOURCE_NOTE, 
  pickBestMatch, formatPrice, fetchExchangeRate, 
  fetchGdmf, collectReleases, normalizePlatform, toBeijingYMD,
  toBeijingShortDate, withCache, formatBytes, checkUrlAccessibility
} = require('./utils');

const { DSF_MAP, BLOCKED_APP_IDS, ADMIN_OPENID, DAILY_REQUEST_LIMIT } = require('./consts');
const { kv } = require('@vercel/kv'); 

const CACHE_TTL_SHORT = 600; 
const CACHE_TTL_LONG = 1800; 

// 1. 榜单查询
async function handleChartQuery(regionName, chartType) {
  const regionCode = getCountryCode(regionName);
  if (!regionCode) return '不支持的地区或格式错误。';

  const cacheKey = `wx:chart:${regionCode}:${chartType === '免费榜' ? 'free' : 'paid'}`;

  return await withCache(cacheKey, CACHE_TTL_SHORT, async () => {
    const typePath = chartType === '免费榜' ? 'topfreeapplications' : 'toppaidapplications';
    const url = `https://itunes.apple.com/${regionCode}/rss/${typePath}/limit=10/json`;

    try {
      const data = await getJSON(url);
      const apps = (data && data.feed && data.feed.entry) || [];
      if (!apps.length) return '获取榜单失败，可能 Apple 接口暂时繁忙。';

      let resultText = `${regionName}${chartType}\n${getFormattedTime()}\n\n`;
      resultText += apps.map((app, idx) => {
        const appId = app.id && app.id.attributes ? app.id.attributes['im:id'] : '';
        const appName = (app['im:name'] && app['im:name'].label) || '未知应用';
        let appUrl = '';
        if (Array.isArray(app.link) && app.link.length > 0) {
            appUrl = app.link[0].attributes.href;
        } else if (app.link && app.link.attributes) {
            appUrl = app.link.attributes.href;
        }
        if (BLOCKED_APP_IDS.has(appId)) return `${idx + 1}、${appName}`;
        return appUrl ? `${idx + 1}、<a href="${appUrl}">${appName}</a>` : `${idx + 1}、${appName}`;
      }).join('\n');

      // 【核心修复】强制使用代码 (如 jp) 生成按钮，配合 Consts 中的双向映射
      const toggleCmd = chartType === '免费榜' ? `${regionCode}付费榜` : `${regionCode}免费榜`;
      resultText += `\n› <a href="weixin://bizmsgmenu?msgmenucontent=${encodeURIComponent(toggleCmd)}&msgmenuid=chart_toggle">查看${chartType === '免费榜' ? '付费' : '免费'}榜单</a>`;
      resultText += `\n\n${SOURCE_NOTE}`;
      return resultText;
    } catch (e) {
      console.error('Chart Query Error:', e.message);
      return '获取榜单失败，请稍后再试。';
    }
  });
}

// 2. 价格查询
async function handlePriceQuery(appName, regionName, isDefaultSearch) {
  const code = getCountryCode(regionName);
  if (!code) return `不支持的地区或格式错误：${regionName}`;

  const cacheKey = `wx:price:${code}:${appName.toLowerCase().replace(/\s/g, '')}`;

  return await withCache(cacheKey, CACHE_TTL_SHORT, async () => {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(appName)}&entity=software&country=${code}&limit=5`;
    try {
      const data = await getJSON(url);
      const results = data.results || [];
      if (!results.length) return `在${regionName}未找到“${appName}”。`;

      const best = pickBestMatch(appName, results);
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

// 3. 商店切换
function handleRegionSwitch(regionName) {
  const regionCode = getCountryCode(regionName);
  const dsf = DSF_MAP[regionCode];
  if (!regionCode || !dsf) return '不支持的地区或格式错误。';

  const stableAppId = '375380948';
  const redirect = `/WebObjects/MZStore.woa/wa/viewSoftware?mt=8&id=${stableAppId}`;
  const fullUrl = `https://itunes.apple.com/WebObjects/MZStore.woa/wa/resetAndRedirect?dsf=${dsf}&cc=${regionCode}&url=${encodeURIComponent(redirect)}`;
  const cnUrl = `https://itunes.apple.com/WebObjects/MZStore.woa/wa/resetAndRedirect?dsf=143465&cc=cn&url=${encodeURIComponent(redirect)}`;

  return `注意！仅浏览，需账号才能下载。\n\n<a href="${fullUrl}">› 点击切换至【${regionName}】 App Store</a>\n\n› 点此切换至 <a href="${cnUrl}">【大陆】</a> App Store\n\n*出现“无法连接”后将自动跳转*`;
}

// 4. 图标查询 (含防404)
async function lookupAppIcon(appName) {
  const cacheKey = `wx:icon:us:${appName.toLowerCase().replace(/\s/g, '')}`;
  return await withCache(cacheKey, CACHE_TTL_SHORT, async () => {
    try {
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(appName)}&country=us&entity=software&limit=1`;
      const data = await getJSON(url);
      if (data.resultCount === 0) return '未找到相关应用，请检查名称。';

      const app = data.results[0];
      const standardIcon = app.artworkUrl512 || app.artworkUrl100;
      const highRes = String(app.artworkUrl100 || '').replace('100x100bb.jpg', '1024x1024bb.jpg');
      
      let finalIcon = standardIcon;
      // 智能降级：如果猜测的高清图不存在，则回退到原图
      if (highRes && highRes !== app.artworkUrl100) {
        if (await checkUrlAccessibility(highRes)) {
          finalIcon = highRes;
        }
      }
      
      const appLink = `<a href="${app.trackViewUrl}">${app.trackName}</a>`;
      return `您查询的“${appName}”最匹配的结果是：\n\n${appLink}\n\n高清图标链接：\n${finalIcon}\n\n${SOURCE_NOTE}`;
    } catch (e) {
      return '查询应用图标失败，请稍后再试。';
    }
  });
}

// 5. 系统更新
async function handleSimpleAllOsUpdates() {
  const cacheKey = `wx:os:simple_all`;
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
      replyText += `› <a href="weixin://bizmsgmenu?msgmenucontent=iOS&msgmenuid=iOS">iOS</a>      › <a href="weixin://bizmsgmenu?msgmenucontent=iPadOS&msgmenuid=iPadOS">iPadOS</a>\n`;
      replyText += `› <a href="weixin://bizmsgmenu?msgmenucontent=macOS&msgmenuid=macOS">macOS</a>    › <a href="weixin://bizmsgmenu?msgmenucontent=watchOS&msgmenuid=watchOS">watchOS</a>\n`;
      return replyText + `\n${SOURCE_NOTE}`;
    } catch (e) {
      return '查询系统版本失败，请稍后再试。';
    }
  });
}

async function handleDetailedOsUpdate(inputPlatform = 'iOS') {
  const platform = normalizePlatform(inputPlatform) || 'iOS';
  const cacheKey = `wx:os:detail:${platform}`;

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

// 6. 应用详情 (极简UI)
async function handleAppDetails(appName) {
  const code = 'us';
  const cacheKey = `wx:detail:us:${appName.toLowerCase().replace(/\s/g, '')}`;

  return await withCache(cacheKey, CACHE_TTL_SHORT, async () => {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(appName)}&entity=software&country=${code}&limit=1`;
    try {
      const data = await getJSON(url);
      if (!data.results || data.results.length === 0) {
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

// 7. 管理后台状态
async function handleAdminStatus(fromUser) {
  if (fromUser !== ADMIN_OPENID) return ''; 

  try {
    const dbSize = await kv.dbsize(); 
    return `【后台管理系统】\n\n状态：运行中\n缓存Key数量：${dbSize}\n每日限额：${DAILY_REQUEST_LIMIT}次/人\n\n系统时间：${getFormattedTime()}`;
  } catch (e) {
    return `后台查询出错：${e.message}`;
  }
}

module.exports = {
  handleChartQuery, handlePriceQuery, handleRegionSwitch, lookupAppIcon,
  handleSimpleAllOsUpdates, handleDetailedOsUpdate, handleAppDetails, handleAdminStatus
};
