// api/wechat.js
const crypto = require('crypto');
const { Parser, Builder } = require('xml2js');
const { ALL_SUPPORTED_REGIONS } = require('./consts');
const { isVIP, setVIP } = require('./utils');
const Handlers = require('./handlers');

const WECHAT_TOKEN = process.env.WECHAT_TOKEN;

// Admin OpenIDs: comma-separated, e.g. "oAbc...,oXyz..."
const ADMIN_OPENIDS = String(process.env.ADMIN_OPENIDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function isAdmin(openId) {
  return !!openId && ADMIN_OPENIDS.includes(String(openId));
}

async function gateOrBypass(openId) {
  if (isAdmin(openId)) return { allowed: true };
  return await checkAbuseGate(openId);
}

const parser = new Parser({ explicitArray: false, trim: true });
const builder = new Builder({ cdata: true, rootName: 'xml', headless: true });

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

// 修复：榜单查询（特别是付费榜查询）时，点击菜单能返回正确地区的榜单
async function handlePostRequest(req, res) {
  let replyContent = '';
  let message = {};
  try {
    const rawBody = await getRawBody(req);
    const parsedXml = await parser.parseStringPromise(rawBody);
    message = parsedXml.xml || {};

    const openId = message.FromUserName;

    if (message.MsgType === 'text' && typeof message.Content === 'string') {
      const content = message.Content.trim();

      const chartV2Match = content.match(/^榜单\s*(.+)$/i); // 榜单查询（任何地区）
      const chartMatch = content.match(/^(.*?)(免费榜|付费榜)$/); // 处理免费榜/付费榜

      // 如果是榜单查询
      if (chartV2Match && isSupportedRegion(chartV2Match[1])) {
        const gate = await gateOrBypass(openId);
        replyContent = gate.allowed
          ? await Handlers.handleChartQuery(chartV2Match[1].trim(), '免费榜')
          : gate.message;
      }

      // 如果是免费榜或者付费榜查询
      else if (chartMatch && isSupportedRegion(chartMatch[1])) {
        const gate = await gateOrBypass(openId);
        const region = chartMatch[1].trim();
        const chartType = chartMatch[2].trim(); // 区分免费榜或付费榜

        // 修复：确保点击菜单时能根据地区选择正确的榜单类型
        replyContent = gate.allowed
          ? await Handlers.handleChartQuery(region, chartType)
          : gate.message;
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
