// api/wechat.js
const crypto = require('crypto');
const { Parser, Builder } = require('xml2js');
const { ALL_SUPPORTED_REGIONS } = require('./consts');
const { isSupportedRegion, checkAbuseGate, checkSubscribeFirstTime } = require('./utils');
const Handlers = require('./handlers');

const WECHAT_TOKEN = process.env.WECHAT_TOKEN;

// Admin OpenIDs
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

async function handlePostRequest(req, res) {
  let replyContent = '';
  let message = {};
  try {
    const rawBody = await getRawBody(req);
    const parsedXml = await parser.parseStringPromise(rawBody);
    message = parsedXml.xml || {};

    const openId = message.FromUserName;

    if (message.MsgType === 'event') {
      if (message.Event === 'subscribe') {
        const { isFirst } = await checkSubscribeFirstTime(openId);
        replyContent = isFirst ? buildWelcomeText('') : buildWelcomeText('欢迎回来！');
      }
    } else if (message.MsgType === 'text' && typeof message.Content === 'string') {
      const content = message.Content.trim();
      console.log(`[Msg] ${openId}: ${content}`);

      if (/^myid$/i.test(content)) {
        replyContent = `你的 OpenID：${openId}`;
      } else {
        // --- 路由匹配 ---
        
        // 1. 榜单查询：匹配 "榜单美国"
        const chartV2Match = content.match(/^榜单\s*(.+)$/i);
        
        // 2. 榜单详情：匹配 "美国付费榜" (优化了正则，容错空格)
        const chartMatch = content.match(/^(.+?)\s*(免费榜|付费榜)$/i);
        
        // 3. 价格查询
        const priceMatchAdvanced = content.match(/^价格\s*(.+?)\s+([a-zA-Z\u4e00-\u9fa5]+)$/i);
        const priceMatchSimple = content.match(/^价格\s*(.+)$/i);
        
        // 4. 其他指令
        const switchRegionMatch = content.match(/^(切换|地区)\s*([a-zA-Z\u4e00-\u9fa5]+)$/i);
        const availabilityMatch = content.match(/^查询\s*(.+)$/i);
        const osAllMatch = /^系统更新$/i.test(content);
        const osUpdateMatch = content.match(/^(iOS|iPadOS|macOS|watchOS|tvOS|visionOS)$/i);
        const iconMatch = content.match(/^图标\s*(.+)$/i);


        // --- 逻辑处理 ---

        if (chartV2Match && isSupportedRegion(chartV2Match[1].trim())) {
          // 命中：榜单美国 -> 默认查免费榜
          const gate = await gateOrBypass(openId);
          replyContent = gate.allowed
            ? await Handlers.handleChartQuery(chartV2Match[1].trim(), '免费榜')
            : gate.message;

        } else if (chartMatch && isSupportedRegion(chartMatch[1].trim())) {
          // 命中：美国付费榜
          // chartMatch[1] = 地区, chartMatch[2] = 类型
          const gate = await gateOrBypass(openId);
          replyContent = gate.allowed
            ? await Handlers.handleChartQuery(chartMatch[1].trim(), chartMatch[2])
            : gate.message;

        } else if (priceMatchAdvanced && isSupportedRegion(priceMatchAdvanced[2])) {
          // 命中：价格 Minecraft 日本
          const gate = await gateOrBypass(openId);
          replyContent = gate.allowed
            ? await Handlers.handlePriceQuery(priceMatchAdvanced[1].trim(), priceMatchAdvanced[2].trim(), false)
            : gate.message;

        } else if (priceMatchSimple) {
          // 命中：价格 YouTube
          const gate = await gateOrBypass(openId);
          if (!gate.allowed) {
            replyContent = gate.message;
          } else {
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
            replyContent = await Handlers.handlePriceQuery(queryAppName, targetRegion, isDefaultSearch);
          }

        } else if (osAllMatch) {
          const gate = await gateOrBypass(openId);
          replyContent = gate.allowed ? await Handlers.handleSimpleAllOsUpdates() : gate.message;

        } else if (osUpdateMatch) {
          const gate = await gateOrBypass(openId);
          replyContent = gate.allowed ? await Handlers.handleDetailedOsUpdate(osUpdateMatch[1].trim()) : gate.message;

        } else if (switchRegionMatch && isSupportedRegion(switchRegionMatch[2])) {
          replyContent = Handlers.handleRegionSwitch(switchRegionMatch[2].trim());

        } else if (availabilityMatch) {
          const gate = await gateOrBypass(openId);
          replyContent = gate.allowed ? await Handlers.handleAvailabilityQuery(availabilityMatch[1].trim()) : gate.message;

        } else if (iconMatch) {
          const appName = iconMatch[1].trim();
          if (appName) {
            const gate = await gateOrBypass(openId);
            replyContent = gate.allowed ? await Handlers.lookupAppIcon(appName) : gate.message;
          }
        }
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
