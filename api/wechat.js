// api/wechat.js
const crypto = require('crypto');
const { Parser, Builder } = require('xml2js');
const { ALL_SUPPORTED_REGIONS } = require('./consts');
const { isSupportedRegion, checkUserRateLimit, checkSubscribeFirstTime } = require('./utils');
const Handlers = require('./handlers');

const WECHAT_TOKEN = process.env.WECHAT_TOKEN;
const parser = new Parser({ explicitArray: false, trim: true });
const builder = new Builder({ cdata: true, rootName: 'xml', headless: true });

function buildWelcomeText(prefixLine = '') {
  const base =
    `恭喜！你发现了果粉秘密基地\n\n` +
    `› <a href="weixin://bizmsgmenu?msgmenucontent=付款方式&msgmenuid=付款方式">付款方式</a>\n获取注册地址信息\n\n` +
    `› <a href="weixin://bizmsgmenu?msgmenucontent=应用查询&msgmenuid=1">应用查询</a>\n热门应用详情查询\n\n` +
    `› <a href="weixin://bizmsgmenu?msgmenucontent=榜单查询&msgmenuid=3">榜单查询</a>\n全球免费付费榜单\n\n` +
    `› <a href="weixin://bizmsgmenu?msgmenucontent=价格查询&msgmenuid=2">价格查询</a>\n应用价格优惠查询\n\n` +
    `› <a href="weixin://bizmsgmenu?msgmenucontent=切换美国&msgmenuid=4">切换美国</a>\n应用商店随意切换\n\n` +
    `› <a href="weixin://bizmsgmenu?msgmenucontent=图标查询&msgmenuid=5">图标查询</a>\n获取官方高清图标\n\n更多服务请戳底部菜单栏了解`;
  return prefixLine ? `${prefixLine}\n\n${base}` : base;
}

const FEATURES = [
  {
    name: 'Admin',
    match: (c) => /^管理后台|后台数据$/i.test(c),
    needAuth: false,
    handler: async (match, openId) => Handlers.handleAdminStatus(openId)
  },
  {
    name: 'MyID', 
    match: (c) => /^myid$/i.test(c),
    needAuth: false,
    handler: async (match, openId) => `你的 OpenID：${openId}`
  },
  // 【新增】榜单查询引导
  {
    name: 'ChartQueryMenu',
    match: (c) => c === '榜单查询',
    needAuth: false,
    handler: async () => '请回复“榜单+地区”，例如：\n\n榜单美国\n榜单日本\n榜单香港'
  },
  {
    name: 'ChartSimple',
    match: (c) => c.match(/^榜单\s*(.+)$/i),
    needAuth: true,
    handler: async (match) => {
      if (!isSupportedRegion(match[1])) return null;
      return Handlers.handleChartQuery(match[1].trim(), '免费榜');
    }
  },
  {
    name: 'ChartDetail',
    match: (c) => c.match(/^(.*?)(免费榜|付费榜)$/),
    needAuth: true,
    handler: async (match) => {
      if (!isSupportedRegion(match[1])) return null;
      return Handlers.handleChartQuery(match[1].trim(), match[2]);
    }
  },
  // 【新增】价格查询引导
  {
    name: 'PriceQueryMenu',
    match: (c) => c === '价格查询',
    needAuth: false,
    handler: async () => '请回复“价格+应用名称”，例如：\n\n价格 YouTube\n价格 Minecraft\n价格 小红书'
  },
  {
    name: 'PriceAdvanced',
    match: (c) => c.match(/^价格\s*(.+?)\s+([a-zA-Z\u4e00-\u9fa5]+)$/i),
    needAuth: true,
    handler: async (match) => {
      if (!isSupportedRegion(match[2])) return null;
      return Handlers.handlePriceQuery(match[1].trim(), match[2].trim(), false);
    }
  },
  {
    name: 'PriceSimple',
    match: (c) => c.match(/^价格\s*(.+)$/i),
    needAuth: true,
    handler: async (match) => {
      let queryAppName = match[1].trim();
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
      return Handlers.handlePriceQuery(queryAppName, targetRegion, isDefaultSearch);
    }
  },
  {
    name: 'SwitchRegion',
    match: (c) => c.match(/^(切换|地区)\s*([a-zA-Z\u4e00-\u9fa5]+)$/i),
    needAuth: false,
    handler: async (match) => {
      if (!isSupportedRegion(match[2])) return null;
      return Handlers.handleRegionSwitch(match[2].trim());
    }
  },
  {
    name: 'AppDetails',
    match: (c) => c.match(/^查询\s*(.+)$/i),
    needAuth: true,
    handler: async (match) => Handlers.handleAppDetails(match[1].trim())
  },
  {
    name: 'AppQueryMenu',
    match: (c) => c === '应用查询',
    needAuth: false,
    handler: async () => '请回复“查询+应用名称”，例如：\n\n查询微信\n查询TikTok\n查询小红书'
  },
  {
    name: 'SystemUpdateAll',
    match: (c) => /^系统更新$/i.test(c),
    needAuth: true,
    handler: async () => Handlers.handleSimpleAllOsUpdates()
  },
  {
    name: 'SystemUpdateDetail',
    match: (c) => c.match(/^更新\s*(iOS|iPadOS|macOS|watchOS|tvOS|visionOS)?$/i),
    needAuth: true,
    handler: async (match) => Handlers.handleDetailedOsUpdate((match[1] || 'iOS').trim())
  },
  // 【新增】图标查询引导
  {
    name: 'IconQueryMenu',
    match: (c) => c === '图标查询',
    needAuth: false,
    handler: async () => '请回复“图标+应用名称”，例如：\n\n图标 QQ\n图标 微信\n图标 TikTok'
  },
  {
    name: 'AppIcon',
    match: (c) => c.match(/^图标\s*(.+)$/i),
    needAuth: true,
    handler: async (match) => Handlers.lookupAppIcon(match[1].trim())
  },
  {
    name: 'Payment',
    match: (c) => c === '付款方式',
    needAuth: false,
    handler: async () => null 
  }
];

module.exports = async (req, res) => {
  if (req.method === 'GET') return handleVerification(req, res);
  
  if (req.method === 'POST') {
    // 4.5秒超时熔断
    const task = handlePostRequest(req, res);
    const timeout = new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), 4500));

    try {
      const result = await Promise.race([task, timeout]);
      if (result === 'TIMEOUT') return res.status(200).send(''); 
      return result; 
    } catch (e) {
      console.error('Main Handler Error:', e);
      return res.status(200).send('');
    }
  }
  res.status(200).send('');
};

async function handlePostRequest(req, res) {
  let replyContent = '';
  let message = {};
  try {
    const rawBody = await getRawBody(req);
    const parsedXml = await parser.parseStringPromise(rawBody);
    message = parsedXml.xml || {};
    const openId = message.FromUserName;

    // 1. 关注事件
    if (message.MsgType === 'event' && message.Event === 'subscribe') {
      const { isFirst } = await checkSubscribeFirstTime(openId);
      replyContent = buildWelcomeText(isFirst ? '' : '欢迎回来！');
    }
    // 2. 文本消息
    else if (message.MsgType === 'text' && typeof message.Content === 'string') {
      const content = message.Content.trim();
      
      // 遍历钥匙扣
      for (const feature of FEATURES) {
        const match = feature.match(content);
        if (match) {
          if (feature.needAuth) {
            const gate = await checkUserRateLimit(openId);
            if (!gate) {
              replyContent = '您今天的查询次数已达上限，请明天再来吧！';
              break;
            }
          }
          try {
            const result = await feature.handler(match, openId);
            if (result) { 
               replyContent = result;
               break; 
            }
          } catch (e) { console.error(`Error in feature ${feature.name}:`, e); }
        }
      }
    }
  } catch (error) { console.error('Error processing POST:', error); }

  if (replyContent) {
    const xml = buildTextReply(message.FromUserName, message.ToUserName, replyContent);
    return res.setHeader('Content-Type', 'application/xml').status(200).send(xml);
  }
  return res.status(200).send('');
}

function handleVerification(req, res) {
  try {
    const { signature, timestamp, nonce, echostr } = req.query;
    const params = [WECHAT_TOKEN || '', timestamp, nonce].sort();
    const hash = crypto.createHash('sha1').update(params.join('')).digest('hex');
    if (hash === signature) return res.status(200).send(echostr);
  } catch {}
  res.status(200).send('');
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk.toString('utf-8')));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function buildTextReply(toUser, fromUser, content) {
  const payload = {
    ToUserName: toUser, FromUserName: fromUser, CreateTime: Math.floor(Date.now() / 1000), MsgType: 'text', Content: content
  };
  return builder.buildObject(payload);
}
