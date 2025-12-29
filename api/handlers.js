// api/handlers.js
const { 
  getCountryCode, getJSON, getFormattedTime, SOURCE_NOTE, 
  pickBestMatch, formatPrice, fetchExchangeRate, 
  fetchGdmf, collectReleases, normalizePlatform, toBeijingYMD 
} = require('./utils');

const { DSF_MAP, BLOCKED_APP_IDS, TARGET_COUNTRIES_FOR_AVAILABILITY } = require('./consts');

// 1. 榜单查询
async function handleChartQuery(regionName, chartType) {
  const regionCode = getCountryCode(regionName);
  if (!regionCode) return '不支持的地区或格式错误。';

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

    const toggleCmd = chartType === '免费榜' ? `${regionName}付费榜` : `${regionName}免费榜`;
    resultText += `\n› <a href="weixin://bizmsgmenu?msgmenucontent=${encodeURIComponent(toggleCmd)}&msgmenuid=${encodeURIComponent(toggleCmd)}">查看${chartType === '免费榜' ? '付费' : '免费'}榜单</a>`;
    resultText += `\n\n${SOURCE_NOTE}`;
    return resultText;
  } catch (e) {
    console.error('Chart Query Error:', e.message || e);
    return '获取榜单失败，请稍后再试。';
  }
}

// 2. 价格查询
async function handlePriceQuery(appName, regionName, isDefaultSearch) {
  const code = getCountryCode(regionName);
  if (!code) return `不支持的地区或格式错误：${regionName}`;

  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(appName)}&entity=software&country=${code}&limit=5`;
  try {
    const data = await getJSON(url);
    const results = data.results || [];
    if (!results.length) return `在${regionName}未找到“${appName}”。`;

    const best = pickBestMatch(appName, results);
    const link = `<a href="${best.trackViewUrl}">${best.trackName}</a>`;
    const priceText = formatPrice(best);

    let replyText = `您搜索的“${appName}”最匹配的结果是：\n\n${link}\n\n地区：${regionName}\n价格：${priceText}`;

    if (typeof best.price === 'number' && best.price > 0 && best.currency) {
      const rate = await fetchExchangeRate(best.currency);
      if (rate) {
        const cnyPrice = (best.price * rate).toFixed(2);
        replyText += ` (≈ ¥${cnyPrice})`;
      }
    }

    replyText += `\n时间：${getFormattedTime()}`;
    if (isDefaultSearch) replyText += `\n\n想查其他地区？试试发送：\n价格${appName}日本`;
    
    return replyText + `\n\n${SOURCE_NOTE}`;
  } catch (e) {
    console.error('Price Query Error:', e);
    return '查询价格失败，请稍后再试。';
  }
}

// 3. 商店切换
function handleRegionSwitch(regionName) {
  const regionCode = getCountryCode(regionName);
  const dsf = DSF_MAP[regionCode];
  if (!regionCode || !dsf) return '不支持的地区或格式错误。';

  const stableAppId = '375380948';
  const redirect = `/WebObjects/MZStore.woa/wa/viewSoftware?mt=8&id=${stableAppId}`;
  const fullUrl = `https://itunes.apple.com/WebObjects/MZStore.woa/wa/resetAndRedirect?dsf=${dsf}&cc=${regionCode}&url=${encodeURIComponent(redirect)}`;

  const cnCode = 'cn';
  const cnDsf = DSF_MAP[cnCode];
  const cnUrl = `https://itunes.apple.com/WebObjects/MZStore.woa/wa/resetAndRedirect?dsf=${cnDsf}&cc=${cnCode}&url=${encodeURIComponent(redirect)}`;

  return `注意！仅浏览，需账号才能下载。\n\n<a href="${fullUrl}">› 点击切换至【${regionName}】 App Store</a>\n\n› 点此切换至 <a href="${cnUrl}">【大陆】</a> App Store\n\n*出现“无法连接”后将自动跳转*\n\n*目前不支持 iOS 26 及以上系统*`;
}

// 4. 上架查询
async function handleAvailabilityQuery(appName) {
  const appInfo = await findAppUniversalId(appName);
  if (!appInfo) {
    return `未能在主要地区（美国、中国）的应用商店中找到「${appName}」，请检查应用名称是否正确。`;
  }
  const availableCountries = await checkAvailability(appInfo.trackId);
  let replyText = `您查询的“${appName}”最匹配的结果是：\n\n${appInfo.trackName}\n\n`;
  replyText += availableCountries.length
    ? `可下载地区：\n${availableCountries.join(', ')}`
    : `在我们查询的热门地区中，均未发现此应用上架。`;
  return replyText + `\n\n${SOURCE_NOTE}`;
}

async function findAppUniversalId(appName) {
  const endpoints = [
    `https://itunes.apple.com/search?term=${encodeURIComponent(appName)}&country=us&entity=software&limit=1`,
    `https://itunes.apple.com/search?term=${encodeURIComponent(appName)}&country=cn&entity=software&limit=1`
  ];
  for (const url of endpoints) {
    try {
      const data = await getJSON(url, { timeout: 4000 });
      if (data.resultCount > 0) {
        const app = data.results[0];
        return { trackId: app.trackId, trackName: app.trackName, trackViewUrl: app.trackViewUrl };
      }
    } catch (e) {
      console.warn('Warning: search error:', e.message || e);
    }
  }
  return null;
}

async function checkAvailability(trackId) {
  const promises = TARGET_COUNTRIES_FOR_AVAILABILITY.map(c =>
    getJSON(`https://itunes.apple.com/lookup?id=${trackId}&country=${c.code}`, { timeout: 4000 })
  );
  const settled = await Promise.allSettled(promises);
  const available = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value && r.value.resultCount > 0) {
      available.push(TARGET_COUNTRIES_FOR_AVAILABILITY[i].name);
    }
  });
  return available;
}

// 5. 图标查询
async function lookupAppIcon(appName) {
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(appName)}&country=us&entity=software&limit=1`;
    const data = await getJSON(url, { timeout: 8000 });
    if (data.resultCount === 0) return '未找到相关应用，请检查名称。';

    const app = data.results[0];
    const highRes = String(app.artworkUrl100 || '').replace('100x100bb.jpg', '1024x1024bb.jpg');
    if (!highRes || highRes === app.artworkUrl100) {
        const fallbackRes = app.artworkUrl512 || app.artworkUrl100;
        if (!fallbackRes) return '抱歉，未能获取到该应用的高清图标。';

        const appLink = `<a href="${app.trackViewUrl}">${app.trackName}</a>`;
        return `您搜索的“${appName}”最匹配的结果是：\n\n${appLink}\n\n这是它的图标链接：\n${fallbackRes}\n\n${SOURCE_NOTE}`;
    }
    const appLink = `<a href="${app.trackViewUrl}">${app.trackName}</a>`;
    return `您搜索的“${appName}”最匹配的结果是：\n\n${appLink}\n\n这是它的高清图标链接：\n${highRes}\n\n${SOURCE_NOTE}`;
  } catch (e) {
    console.error('Error in lookupAppIcon:', e.message || e);
    return '查询应用图标失败，请稍后再试。';
  }
}

// 6. 系统更新
async function handleSimpleAllOsUpdates() {
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
    replyText += `› <a href="weixin://bizmsgmenu?msgmenucontent=tvOS&msgmenuid=tvOS">tvOS</a>      › <a href="weixin://bizmsgmenu?msgmenucontent=visionOS&msgmenuid=visionOS">visionOS</a>\n`;
    replyText += `\n${SOURCE_NOTE}`;

    return replyText;
  } catch (e) {
    console.error('Error in handleSimpleAllOsUpdates:', e.message || e);
    return '查询系统版本失败，请稍后再试。';
  }
}

async function handleDetailedOsUpdate(inputPlatform = 'iOS') {
  const platform = normalizePlatform(inputPlatform) || 'iOS';
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

    const latestDateStr = toBeijingYMD(latest.date) || '未知日期';

    const lines = list.slice(0,5).map(r=>{
      const t = toBeijingYMD(r.date);
      const releaseTag = /beta/i.test(JSON.stringify(r.raw)) ? ' (Beta)' :
                         /rc|seed/i.test(JSON.stringify(r.raw)) ? ' (RC)' : '';
      return `• ${r.os} ${r.version} (${r.build})${releaseTag}${t?` — ${t}`:''}`;
    });

    return `${platform} 最新公开版本：\n版本：${latest.version}（${latest.build}）${stableTag}\n发布时间：${latestDateStr}\n\n近期版本：\n${lines.join('\n')}\n\n查询时间：${getFormattedTime()}\n\n${SOURCE_NOTE}`;
  } catch (e) {
    console.error('Error in handleDetailedOsUpdate:', e.message || e);
    return '查询系统版本失败，请稍后再试。';
  }
}

module.exports = {
  handleChartQuery,
  handlePriceQuery,
  handleRegionSwitch,
  handleAvailabilityQuery,
  lookupAppIcon,
  handleSimpleAllOsUpdates,
  handleDetailedOsUpdate
};
