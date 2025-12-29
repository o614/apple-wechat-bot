// api/wechat.js
const crypto = require('crypto');
const axios = require('axios');
const { Parser, Builder } = require('xml2js');
const https = require('https');

// 引入外部数据文件 (保持分离结构)
const { ALL_SUPPORTED_REGIONS, DSF_MAP, BLOCKED_APP_IDS, TARGET_COUNTRIES_FOR_AVAILABILITY } = require('./consts');

const WECHAT_TOKEN = process.env.WECHAT_TOKEN;

// 【新增 1】定义小票分割线常量
const SEPARATOR = '------------------------------';

const parser = new Parser({ explicitArray: false, trim: true });
const builder = new Builder({ cdata: true, rootName: 'xml', headless: true });

const HTTP = axios.create({
  timeout: 4000, 
  headers: { 'user-agent': 'Mozilla/5.0 (Serverless-WeChatBot)' }
});

const SOURCE_NOTE = '*数据来源 Apple 官方*';

module.exports = async (req, res) => {
  if (req.method === 'GET') return handleVerification(req, res);
  if (req.method === 'POST') return handlePostRequest(req, res);
  res.status(200).send('');
};

function handleVerification(req, res) {
  try {
    const { signature, timestamp, nonce, echostr } = req.query;
    const params = [WECHAT_TOKEN || '', timestamp, nonce].sort();
    const hash = crypto.createHash('sha1').update(params.join('')).digest('hex');
    if (hash === signature) return res.status(200).send(echostr);
  } catch {}
  res.status(200).send('');
}

async function handlePostRequest(req, res) {
  let replyContent = '';
  let message = {};
  try {
    const rawBody = await getRawBody(req);
    const parsedXml = await parser.parseStringPromise(rawBody);
    message = parsedXml.xml || {};

    if (message.MsgType === 'event' && message.Event === 'subscribe') {
      // 【修改】应用分割线
      replyContent =
        `恭喜！你发现了果粉秘密基地\n` +
        `${SEPARATOR}\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=付款方式&msgmenuid=付款方式">付款方式</a>\n获取注册地址信息\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=查询TikTok&msgmenuid=1">查询TikTok</a>\n热门地区上架查询\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=榜单美国&msgmenuid=3">榜单美国</a>\n全球免费付费榜单\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=价格YouTube&msgmenuid=2">价格YouTube</a>\n应用价格优惠查询\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=切换美国&msgmenuid=4">切换美国</a>\n应用商店随意切换\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=图标QQ&msgmenuid=5">图标QQ</a>\n获取官方高清图标\n` +
        `${SEPARATOR}\n` +
        `更多服务请戳底部菜单栏了解`;
    } else if (message.MsgType === 'text' && typeof message.Content === 'string') {
      const content = message.Content.trim();
      
      const chartV2Match = content.match(/^榜单\s*(.+)$/i); 
      const chartMatch = content.match(/^(.*?)(免费榜|付费榜)$/); 
      const priceMatchAdvanced = content.match(/^价格\s*(.+?)\s+([a-zA-Z\u4e00-\u9fa5]+)$/i); 
      const priceMatchSimple = content.match(/^价格\s*(.+)$/i); 
      const switchRegionMatch = content.match(/^(切换|地区)\s*([a-zA-Z\u4e00-\u9fa5]+)$/i); 
      const availabilityMatch = content.match(/^查询\s*(.+)$/i); 
      const osAllMatch = /^系统更新$/i.test(content);
      
      // 【修改 1】OS指令正则更新：直接匹配 iOS, iPadOS 等单词，不区分大小写，不需要"更新"前缀
      const osUpdateMatch = content.match(/^(iOS|iPadOS|macOS|watchOS|tvOS|visionOS)$/i); 
      
      const iconMatch = content.match(/^图标\s*(.+)$/i); 

      if (chartV2Match && isSupportedRegion(chartV2Match[1])) {
        replyContent = await handleChartQuery(chartV2Match[1].trim(), '免费榜');
      } else if (chartMatch && isSupportedRegion(chartMatch[1])) {
        replyContent = await handleChartQuery(chartMatch[1].trim(), chartMatch[2]);
      } else if (priceMatchAdvanced && isSupportedRegion(priceMatchAdvanced[2])) {
        replyContent = await handlePriceQuery(priceMatchAdvanced[1].trim(), priceMatchAdvanced[2].trim(), false);
      } else if (priceMatchSimple) {
        // 智能无空格匹配逻辑
        let queryAppName = priceMatchSimple[1].trim();
        let targetRegion = '美国';
        let isDefaultSearch = true;
        for (const countryName in ALL_SUPPORTED_REGIONS) {
          if (queryAppName.endsWith(countryName) && queryAppName.length > countryName.length) {
            targetRegion = countryName;
            queryAppName = queryAppName.slice(0, -countryName.length).trim();
            isDefaultSearch = false; 
            break; 
          }
        }
        replyContent = await handlePriceQuery(queryAppName, targetRegion, isDefaultSearch);

      } else if (osAllMatch) {
        replyContent = await handleSimpleAllOsUpdates();
      } else if (osUpdateMatch) {
        // 【修改 2】直接获取捕获到的系统名 (例如 "ios")
        const platform = osUpdateMatch[1].trim();
        replyContent = await handleDetailedOsUpdate(platform);
      } else if (switchRegionMatch && isSupportedRegion(switchRegionMatch[2])) {
        replyContent = handleRegionSwitch(switchRegionMatch[2].trim());
      } else if (availabilityMatch) {
        replyContent = await handleAvailabilityQuery(availabilityMatch[1].trim());
      } else if (iconMatch) { 
        const appName = iconMatch[1].trim();
        if (appName) replyContent = await lookupAppIcon(appName);
      }
    }
  } catch (error) {
    console.error('Error processing POST:', error.message || error);
  }

  if (replyContent) {
    const xml = buildTextReply(message.FromUserName, message.ToUserName, replyContent);
    return res.setHeader('Content-Type', 'application/xml').status(200).send(xml);
  }
  return res.status(200).send('');
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk.toString('utf-8')));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function getCountryCode(identifier) {
  const trimmed = String(identifier || '').trim();
  const key = trimmed.toLowerCase();
  if (ALL_SUPPORTED_REGIONS[trimmed]) return ALL_SUPPORTED_REGIONS[trimmed];
  if (/^[a-z]{2}$/i.test(key)) {
    for (const name in ALL_SUPPORTED_REGIONS) {
      if (ALL_SUPPORTED_REGIONS[name] === key) return key;
    }
  }
  return '';
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

function buildTextReply(toUser, fromUser, content) {
  const payload = {
    ToUserName: toUser,
    FromUserName: fromUser,
    CreateTime: Math.floor(Date.now() / 1000),
    MsgType: 'text',
    Content: content
  };
  return builder.buildObject(payload);
}

async function getJSON(url, { timeout = 6000, retries = 1 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const { data } = await HTTP.get(url, { timeout });
      return data;
    } catch (err) {
      lastErr = err;
      if (i < retries) await new Promise(r => setTimeout(r, 250 * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

// 榜单查询 (旧版接口)
async function handleChartQuery(regionName, chartType) {
  const regionCode = getCountryCode(regionName);
  if (!regionCode) return '不支持的地区或格式错误。';

  const typePath = chartType === '免费榜' ? 'topfreeapplications' : 'toppaidapplications';
  const url = `https://itunes.apple.com/${regionCode}/rss/${typePath}/limit=10/json`;

  try {
    const data = await getJSON(url);
    const apps = (data && data.feed && data.feed.entry) || [];
    
    if (!apps.length) return '获取榜单失败，可能 Apple 接口暂时繁忙。';

    // 【修改】应用分割线
    let resultText = `${regionName}${chartType}\n${SEPARATOR}\n${getFormattedTime()}\n\n`;

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
    
    // 【修改】应用分割线
    resultText += `\n${SEPARATOR}\n${SOURCE_NOTE}`;
    return resultText;
  } catch (e) {
    console.error('Chart Query Error:', e.message || e);
    return '获取榜单失败，请稍后再试。';
  }
}

function pickBestMatch(query, results) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return results[0];
  const exact = results.find(r => String(r.trackName || '').toLowerCase() === q);
  if (exact) return exact;
  const contains = results.find(r => String(r.trackName || '').toLowerCase().includes(q));
  if (contains) return contains;
  return results[0];
}

function formatPrice(r) {
  if (r.formattedPrice) return r.formattedPrice.replace(/^Free$/i, '免费');
  if (typeof r.price === 'number') {
    return r.price === 0 ? '免费' : `${r.currency || ''} ${r.price.toFixed(2)}`.trim();
  }
  return '未知';
}

// 汇率查询 (Frankfurter V3.0)
async function fetchExchangeRate(targetCurrencyCode) {
  if (!targetCurrencyCode || targetCurrencyCode.toUpperCase() === 'CNY') return null;
  try {
    const url = `https://api.frankfurter.app/latest?from=${targetCurrencyCode.toUpperCase()}&to=CNY`;
    const { data } = await axios.get(url, { timeout: 3000 });
    if (data && data.rates && data.rates.CNY) {
      return data.rates.CNY;
    }
  } catch (e) {
    console.error(`Exchange Rate Error (${targetCurrencyCode}):`, e.message);
  }
  return null;
}

async function handlePriceQuery(appName, regionName, isDefaultSearch) {
  const code = getCountryCode(regionName);
  if (!code) return `不支持的地区或格式错误：${regionName}`;

  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(appName)}&entity=software&country=${code}&limit=5`;
  try {
    const data = await getJSON(url);
    const results = data.results || [];
    if (!results.length) return `在${regionName}未找到“${appName}”。`;

    const best = pickBestMatch(appName, results);
    
    // 【修改】使用 smartWrap 限制标题宽度
    const safeTitle = smartWrap(best.trackName);
    const link = `<a href="${best.trackViewUrl}">${safeTitle}</a>`;
    const priceText = formatPrice(best);

    // 【修改】应用分割线
    let replyText = `您搜索的“${appName}”最匹配的结果是：\n${SEPARATOR}\n${link}\n\n地区：${regionName}\n价格：${priceText}`;

    if (typeof best.price === 'number' && best.price > 0 && best.currency) {
      const rate = await fetchExchangeRate(best.currency);
      if (rate) {
        const cnyPrice = (best.price * rate).toFixed(2);
        replyText += ` (≈ ¥${cnyPrice})`;
      }
    }

    replyText += `\n\n时间：${getFormattedTime()}\n${SEPARATOR}`;
    // 【修改 3】去掉建议指令中的空格
    if (isDefaultSearch) replyText += `\n想查其他地区？试试发送：\n价格${appName}日本\n`;
    
    return replyText + `\n${SOURCE_NOTE}`;
  } catch (e) {
    console.error('Price Query Error:', e);
    return '查询价格失败，请稍后再试。';
  }
}

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

  // 【修改】应用分割线
  return `注意！仅浏览，需账号才能下载。\n${SEPARATOR}\n\n<a href="${fullUrl}">› 点击切换至【${regionName}】 App Store</a>\n\n› 点此切换至 <a href="${cnUrl}">【大陆】</a> App Store\n\n${SEPARATOR}\n*出现“无法连接”后将自动跳转*\n\n*目前暂不支持 iOS 26 系统*`;
}

async function handleAvailabilityQuery(appName) {
  const appInfo = await findAppUniversalId(appName);
  if (!appInfo) {
    return `未能在主要地区（美国、中国）的应用商店中找到「${appName}」，请检查应用名称是否正确。`;
  }
  const availableCountries = await checkAvailability(appInfo.trackId);
  
  // 【修改】应用分割线和 smartWrap
  let replyText = `您查询的“${appName}”最匹配的结果是：\n${SEPARATOR}\n${smartWrap(appInfo.trackName)}\n\n`;
  replyText += availableCountries.length
    ? `可下载地区：\n${availableCountries.join(', ')}`
    : `在我们查询的热门地区中，均未发现此应用上架。`;
  return replyText + `\n${SEPARATOR}\n${SOURCE_NOTE}`;
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

        // 【修改】应用分割线和 smartWrap
        const appLink = `<a href="${app.trackViewUrl}">${smartWrap(app.trackName)}</a>`;
        return `您搜索的“${appName}”最匹配的结果是：\n${SEPARATOR}\n${appLink}\n\n这是它的图标链接：\n${fallbackRes}\n${SEPARATOR}\n${SOURCE_NOTE}`;
    }
    // 【修改】应用分割线和 smartWrap
    const appLink = `<a href="${app.trackViewUrl}">${smartWrap(app.trackName)}</a>`;
    return `您搜索的“${appName}”最匹配的结果是：\n${SEPARATOR}\n${appLink}\n\n这是它的高清图标链接：\n${highRes}\n${SEPARATOR}\n${SOURCE_NOTE}`;
  } catch (e) {
    console.error('Error in lookupAppIcon:', e.message || e);
    return '查询应用图标失败，请稍后再试。';
  }
}

async function fetchGdmf() {
  const url = 'https://gdmf.apple.com/v2/pmv';
  const headers = {
    // 【修改】只更新了这里的 User-Agent
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*'
  };
  const agent = new https.Agent({ rejectUnauthorized: false });
  try {
    const response = await HTTP.get(url, { timeout: 4000, headers: headers, httpsAgent: agent });
    if (!response.data || typeof response.data !== 'object') {
        console.error('fetchGdmf Error: Received invalid data format from GDMF.');
        throw new Error('Received invalid data format from GDMF.');
    }
    return response.data;
  } catch (error) {
    let errorMsg = 'fetchGdmf Error: Request failed.';
    if (error.response) {
      errorMsg = `fetchGdmf Error: Request failed with status ${error.response.status}. URL: ${url}`;
      console.error(errorMsg, 'Response data:', error.response.data);
    } else if (error.request) {
      errorMsg = `fetchGdmf Error: No response received. Code: ${error.code || 'N/A'}. URL: ${url}`;
      console.error(errorMsg, 'Is timeout?', error.code === 'ECONNABORTED');
    } else {
      errorMsg = `fetchGdmf Error: Request setup failed or unknown error. Message: ${error.message || 'N/A'}. URL: ${url}`;
      console.error(errorMsg);
    }
    throw new Error(errorMsg);
  }
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

// 【修改 4】系统更新概览：链接优化 (去掉"更新"和"详情"文字，变成两列蓝色可点击)
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

    // 【修改】应用分割线
    let replyText = `最新系统版本：\n${SEPARATOR}\n${results.join('\n')}\n\n查看详情：\n`;
    
    replyText += `› <a href="weixin://bizmsgmenu?msgmenucontent=iOS&msgmenuid=iOS">iOS</a>      › <a href="weixin://bizmsgmenu?msgmenucontent=iPadOS&msgmenuid=iPadOS">iPadOS</a>\n`;
    replyText += `› <a href="weixin://bizmsgmenu?msgmenucontent=macOS&msgmenuid=macOS">macOS</a>    › <a href="weixin://bizmsgmenu?msgmenucontent=watchOS&msgmenuid=watchOS">watchOS</a>\n`;
    replyText += `› <a href="weixin://bizmsgmenu?msgmenucontent=tvOS&msgmenuid=tvOS">tvOS</a>      › <a href="weixin://bizmsgmenu?msgmenucontent=visionOS&msgmenuid=visionOS">visionOS</a>\n`;
    replyText += `\n${SEPARATOR}\n${SOURCE_NOTE}`;

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

    // 【修改】应用分割线
    return `${platform} 最新公开版本：\n${SEPARATOR}\n版本：${latest.version}（${latest.build}）${stableTag}\n发布时间：${latestDateStr}\n\n近期版本：\n${lines.join('\n')}\n\n查询时间：${getFormattedTime()}\n${SEPARATOR}\n${SOURCE_NOTE}`;
  } catch (e) {
    console.error('Error in handleDetailedOsUpdate:', e.message || e);
    return '查询系统版本失败，请稍后再试。';
  }
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
                      const version = node.ProductVersion || node.OSVersion || node.SystemVersion || null;
                      const build   = node.Build || node.BuildID || node.BuildVersion || null;
                      const dateStr = node.PostingDate || node.ReleaseDate || node.Date || node.PublishedDate || node.PublicationDate || null;
                      const devices = node.SupportedDevices;

                      if (version && build && !foundBuilds.has(build)) {
                          const actualPlatforms = determinePlatformsFromDevices(devices);
                          if (actualPlatforms.has(targetOS)) {
                              releases.push({ os: targetOS, version, build, date: dateStr, raw: node });
                              foundBuilds.add(build);
                          }
                          else if (targetOS === 'iPadOS' && actualPlatforms.has('iOS')) {
                              const versionNum = parseFloat(version);
                              if (!isNaN(versionNum) && versionNum >= 13.0) {
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

    let hasIOS = false;
    let hasIPadOS = false;
    let hasWatchOS = false;
    let hasTVOS = false;
    let hasMacOS = false;
    let hasVisionOS = false;

    for (const device of devices) {
        const d = String(device || '').toLowerCase();
        if (d.startsWith('iphone') || d.startsWith('ipod')) hasIOS = true;
        else if (d.startsWith('ipad')) hasIPadOS = true;
        else if (d.startsWith('watch')) hasWatchOS = true;
        else if (d.startsWith('appletv') || d.startsWith('audioaccessory')) hasTVOS = true;
        else if (d.startsWith('j') || d.startsWith('mac-') || d.includes('macos') || d.startsWith('vmm') || d.startsWith('x86') || /^[A-Z]\d{3}[A-Z]{2}AP$/i.test(device)) hasMacOS = true;
        else if (d.startsWith('realitydevice')) hasVisionOS = true;
    }

    if (hasIOS) platforms.add('iOS');
    if (hasIPadOS) platforms.add('iPadOS');
    if (hasWatchOS) platforms.add('watchOS');
    if (hasTVOS) platforms.add('tvOS');
    if (hasMacOS) platforms.add('macOS');
    if (hasVisionOS) platforms.add('visionOS');

    return platforms;
}

// 【新增 2】智能折行函数
function smartWrap(text, maxLimit = 26) {
  if (!text) return '';
  let result = '';
  let count = 0;
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    // 汉字算 2 分，英文/数字算 1 分
    const len = (char.charCodeAt(0) > 255) ? 2 : 1;
    
    // 如果加上这个字就超标了，先换行，再重置计数器
    if (count + len > maxLimit) {
      result += '\n';
      count = 0;
    }
    
    result += char;
    count += len;
  }
  return result;
}
