// api/wechat.js
const crypto = require('crypto');
const axios = require('axios');
const { Parser, Builder } = require('xml2js');
const store = require('app-store-scraper'); // 仅用于搜索ID，不用于抓详情
const cheerio = require('cheerio'); // 用于解析HTML

// 引入外部数据
const { ALL_SUPPORTED_REGIONS, DSF_MAP, BLOCKED_APP_IDS, TARGET_COUNTRIES_FOR_AVAILABILITY } = require('./consts');

const WECHAT_TOKEN = process.env.WECHAT_TOKEN;
const parser = new Parser({ explicitArray: false, trim: true });
const builder = new Builder({ cdata: true, rootName: 'xml', headless: true });

const HTTP = axios.create({
  timeout: 8000, 
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

    if (message.MsgType === 'text' && typeof message.Content === 'string') {
      const content = message.Content.trim();
      
      const chartV2Match = content.match(/^榜单\s*(.+)$/i); 
      const chartMatch = content.match(/^(.*?)(免费榜|付费榜)$/); 
      const priceMatchAdvanced = content.match(/^价格\s*(.+?)\s+([a-zA-Z\u4e00-\u9fa5]+)$/i); 
      const priceMatchSimple = content.match(/^价格\s*(.+)$/i); 
      
      // 逻辑路由
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

// --- 核心爬虫：手动抓取内购 ---
// --- 核心爬虫：手动抓取内购 (通用暴力版) ---
async function scrapeIAP(appUrl) {
  try {
    const { data: html } = await axios.get(appUrl, {
      headers: {
        // 伪装成最新的 Chrome，防止被识别为老旧设备
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
    });

    const $ = cheerio.load(html);
    const iapList = [];

    // 策略 A: 通过 "信息" (Information) 栏目定位
    // Apple 的内购通常在 <dt>App 内购买项目</dt> 旁边的 <dd> 里
    let ddContainer = $('dt:contains("App 内购买项目"), dt:contains("In-App Purchases")').next('dd');
    
    // 如果策略 A 没找到，尝试策略 B: 找 h2 标题
    if (ddContainer.length === 0) {
        ddContainer = $('h2:contains("App 内购买项目"), h2:contains("In-App Purchases")').parent().next();
    }

    // 遍历容器里的 li 元素
    ddContainer.find('li').each((i, el) => {
      if (i >= 8) return; // 限制数量

      // 尝试提取两段式结构 (名字 + 价格)
      // 这里的结构通常是: <div>名字</div> <div>价格</div>
      let name = $(el).find('span').first().text().trim();
      let price = $(el).find('span').last().text().trim();

      // 如果没找到 span，直接取纯文本进行分割
      if (!name || !price || name === price) {
          const rawText = $(el).text().trim().replace(/\s+/g, ' '); // 压缩空格
          // 尝试用正则拆分价格 (匹配 ¥ 或 $ 结尾的部分)
          const match = rawText.match(/(.+?)\s+([¥$]\s?[\d.,]+)/);
          if (match) {
              name = match[1];
              price = match[2];
          } else {
              // 实在拆不开，就整行显示
              name = rawText;
              price = '';
          }
      }

      if (name) {
        iapList.push(price ? `${name}: ${price}` : name);
      }
    });

    if (iapList.length > 0) {
      return 'App 内购买项目 (参考)：\n' + iapList.join('\n');
    }
    
    return '未检测到内购项目 (可能该应用无内购)';

  } catch (e) {
    console.error('Scrape Error:', e.message);
    if (e.response && (e.response.status === 403 || e.response.status === 429)) {
        return '内购数据获取失败 (服务器 IP 被限制)';
    }
    return '内购数据获取失败';
  }
}

// 核心功能：价格查询
async function handlePriceQuery(appName, regionName, isDefaultSearch) {
  const code = getCountryCode(regionName);
  if (!code) return `不支持的地区或格式错误：${regionName}`;

  try {
    // 1. 使用 app-store-scraper 搜索 App (只为了拿 ID 和 URL)
    const results = await store.search({
      term: appName,
      num: 1,
      country: code
    });

    if (!results || results.length === 0) {
      return `在 ${regionName} 未找到应用：${appName}`;
    }

    const app = results[0];
    const link = `<a href="${app.url}">${app.title}</a>`;
    const priceText = app.free ? '免费' : (app.priceText || app.price); // 优先用格式化好的价格

    let replyText = `应用名称：${app.title}\n链接：${link}\n\n地区：${regionName}\n当前价格：${priceText}`;

    // 2. 调用手动爬虫获取内购
    const iapInfo = await scrapeIAP(app.url);
    replyText += `\n\n${iapInfo}`;

    replyText += `\n\n查询时间：${getFormattedTime()}`;
    if (isDefaultSearch) replyText += `\n想查其他地区？试试发送：\n价格${appName}日本`;
    
    return replyText + `\n\n${SOURCE_NOTE}`;

  } catch (e) {
    console.error(e);
    return '查询失败，请稍后再试。';
  }
}

// --- 以下是辅助函数 (保持不变) ---

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

async function getJSON(url) {
  const { data } = await HTTP.get(url);
  return data;
}

async function handleChartQuery(regionName, chartType) {
  const regionCode = getCountryCode(regionName);
  if (!regionCode) return '不支持的地区或格式错误。';

  // 使用旧版稳定接口
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

      if (BLOCKED_APP_IDS.has(appId)) return `${idx + 1}. ${appName}`;
      return appUrl ? `${idx + 1}. <a href="${appUrl}">${appName}</a>` : `${idx + 1}. ${appName}`;
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

