// api/wechat.js
const crypto = require('crypto');
const { Parser, Builder } = require('xml2js');
const { ALL_SUPPORTED_REGIONS } = require('./consts');
const { isSupportedRegion, checkAbuseGate, checkSubscribeFirstTime } = require('./utils');
const Handlers = require('./handlers');

const WECHAT_TOKEN = process.env.WECHAT_TOKEN;
const parser = new Parser({ explicitArray: false, trim: true });
const builder = new Builder({ cdata: true, rootName: 'xml', headless: true });

// Admin OpenIDs
const ADMIN_OPENIDS = String(process.env.ADMIN_OPENIDS || '').split(',').map(s => s.trim()).filter(Boolean);
function isAdmin(openId) { return !!openId && ADMIN_OPENIDS.includes(String(openId)); }
async function gateOrBypass(openId) {
  if (isAdmin(openId)) return { allowed: true };
  return await checkAbuseGate(openId);
}

// 欢迎语构建函数 (确保在 wechat.js 中可用)
function buildWelcomeText(prefixLine = '') {
  const base =
    `恭喜！你发现了果粉秘密基地\n\n` +
    `› <a href="weixin://bizmsgmenu?msgmenucontent=付款方式&msgmenuid=付款方式">付款方式</a>\n获取注册地址信息\n\n` +
    `› <a href="weixin://bizmsgmenu?msgmenucontent=查询TikTok&msgmenuid=1">查询TikTok</a>\n热门地区上架查询\n\n` +
    `› <a href="weixin://bizmsgmenu?msgmenucontent=榜单美国&msgmenuid=3">榜单美国</a>\n全球免费付费榜单\n\n` +
    `› <a href="weixin://bizmsgmenu?msgmenucontent=价格YouTube&msgmenuid=2">价格YouTube</a>\n应用价格优惠查询\n\n` +
    `› <a href="weixin://bizmsgmenu?msgmenucontent=切换美国&msgmenuid=4">切换美国</a>\n应用商店随意切换\n\n` +
    `› <a href="weixin://bizmsgmenu?msgmenucontent=图标QQ&msgmenuid=5">图标QQ</a>\n获取官方高清图标\n\n更多服务请戳底部菜单栏了解`;
  return prefixLine ? `${prefixLine}\n\n${base}` : base;
}

// ==========================================
// 🔑 钥匙扣定义 (Features)
// ==========================================
const FEATURES = [
  {
    name: 'MyID',
    match: (c) => /^myid$/i.test(c),
    needAuth: false,
    handler: async (match, openId) => `你的 OpenID：${openId}`
  },
  {
    name: 'ChartSimple', // 榜单查询 (榜单美国)
    match: (c) => c.match(/^榜单\s*(.+)$/i),
    needAuth: true,
    handler: async (match) => {
      if (!isSupportedRegion(match[1])) return null;
      return Handlers.handleChartQuery(match[1].trim(), '免费榜');
    }
  },
  {
    name: 'ChartDetail', // 榜单详情 (美国付费榜) - 使用你旧代码的好用逻辑
    match: (c) => c.match(/^(.*?)(免费榜|付费榜)$/),
    needAuth: true,
    handler: async (match) => {
      if (!isSupportedRegion(match[1])) return null;
      return Handlers.handleChartQuery(match[1].trim(), match[2]);
    }
  },
  {
    name: 'PriceAdvanced', // 价格查询 (价格 Minecraft 日本)
    match: (c) => c.match(/^价格\s*(.+?)\s+([a-zA-Z\u4e00-\u9fa5]+)$/i),
    needAuth: true,
    handler: async (match) => {
      if (!isSupportedRegion(match[2])) return null;
      return Handlers.handlePriceQuery(match[1].trim(), match[2].trim(), false);
    }
  },
  {
    name: 'PriceSimple', // 价格查询 (价格 YouTube)
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
    name: 'SwitchRegion', // 切换地区
    match: (c) => c.match(/^(切换|地区)\s*([a-zA-Z\u4e00-\u9fa5]+)$/i),
    needAuth: false,
    handler: async (match) => {
      if (!isSupportedRegion(match[2])) return null;
      return Handlers.handleRegionSwitch(match[2].trim());
    }
  },
  {
    name: 'Availability', // 上架查询
    match: (c) => c.match(/^查询\s*(.+)$/i),
    needAuth: true,
    handler: async (match) => Handlers.handleAvailabilityQuery(match[1].trim())
  },
  {
    name: 'SystemUpdateAll', // 系统更新概览
    match: (c) => /^系统更新$/i.test(c),
    needAuth: true,
    handler: async () => Handlers.handleSimpleAllOsUpdates()
  },
  {
    name: 'SystemUpdateDetail', // 系统更新详情
    match: (c) => c.match(/^更新\s*(iOS|iPadOS|macOS|watchOS|tvOS|visionOS)?$/i),
    needAuth: true,
    handler: async (match) => Handlers.handleDetailedOsUpdate((match[1] || 'iOS').trim())
  },
  {
    name: 'AppIcon', // 图标查询
    match: (c) => c.match(/^图标\s*(.+)$/i),
    needAuth: true,
    handler: async (match) => Handlers.lookupAppIcon(match[1].trim())
  },
  {
    name: 'Payment', // 付款方式 (静默)
    match: (c) => c === '付款方式',
    needAuth: false,
    handler: async () => { return null; } // 返回 null 表示不回复
  }
];

// ==========================================
// 🎮 主逻辑
// ==========================================
module.exports = async (req, res) => {
  if (req.method === 'GET') return handleVerification(req, res);
  if (req.method === 'POST') return handlePostRequest(req, res);
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

    // 1. 关注事件 (修复: 明确处理 subscribe)
    if (message.MsgType === 'event' && message.Event === 'subscribe') {
      const { isFirst } = await checkSubscribeFirstTime(openId);
      replyContent = buildWelcomeText(isFirst ? '' : '欢迎回来！');
    }
    // 2. 文本消息
    else if (message.MsgType === 'text' && typeof message.Content === 'string') {
      const content = message.Content.trim();
      console.log(`[Msg] User: ${openId} | Content: "${content}"`);

      // 🔄 遍历钥匙扣
      for (const feature of FEATURES) {
        const match = feature.match(content);
        if (match) {
          console.log(`[Router] Matched: ${feature.name}`);
          
          if (feature.needAuth) {
            const gate = await gateOrBypass(openId);
            if (!gate.allowed) {
              replyContent = gate.message;
              break;
            }
          }
          
          try {
            const result = await feature.handler(match, openId);
            if (result) { 
               replyContent = result;
               break; 
            }
          } catch (e) {
            console.error(`Error in feature ${feature.name}:`, e);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error processing POST:', error);
  }

  if (replyContent) {
    const xml = buildTextReply(message.FromUserName, message.ToUserName, replyContent);
    return res.setHeader('Content-Type', 'application/xml').status(200).send(xml);
  }
  return res.status(200).send('');
}

// Helpers
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
    ToUserName: toUser,
    FromUserName: fromUser,
    CreateTime: Math.floor(Date.now() / 1000),
    MsgType: 'text',
    Content: content
  };
  return builder.buildObject(payload);
}
