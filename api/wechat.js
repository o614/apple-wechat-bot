// api/wechat.js
const crypto = require('crypto');
const { Parser, Builder } = require('xml2js');
const { ALL_SUPPORTED_REGIONS } = require('./consts');
const { isSupportedRegion, checkUsageLimit, manageVip } = require('./utils');
const Handlers = require('./handlers');

const WECHAT_TOKEN = process.env.WECHAT_TOKEN;

const ADMIN_OPENIDS = String(process.env.ADMIN_OPENIDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Daily limits (VIP users are exempt)
const DAILY_LIMITS = {
  global: Number(process.env.DAILY_LIMIT_GLOBAL || 30),
  chart: Number(process.env.DAILY_LIMIT_CHART || 10),
  price: Number(process.env.DAILY_LIMIT_PRICE || 10),
  availability: Number(process.env.DAILY_LIMIT_AVAILABILITY || 10),
  icon: Number(process.env.DAILY_LIMIT_ICON || 3),
  updates_all: Number(process.env.DAILY_LIMIT_UPDATES_ALL || 15),
  updates_detail: Number(process.env.DAILY_LIMIT_UPDATES_DETAIL || 15),
  switch: Number(process.env.DAILY_LIMIT_SWITCH || 20)
};

function isAdmin(openId) {
  return ADMIN_OPENIDS.length > 0 && ADMIN_OPENIDS.includes(String(openId || '').trim());
}

async function enforceLimits(openId, action) {
  // Global first
  const g = await checkUsageLimit(openId, 'global', DAILY_LIMITS.global);
  if (!g.allowed) return { allowed: false, limit: g.limit || DAILY_LIMITS.global };

  const limit = DAILY_LIMITS[action];
  if (!limit) return { allowed: true };

  const r = await checkUsageLimit(openId, action, limit);
  if (!r.allowed) return { allowed: false, limit: r.limit || limit };

  return { allowed: true };
}

function limitExceededText(limit) {
  return `今日使用次数已达上限（${limit}次/天）。\n如需更多次数可联系管理员开通 VIP。`;
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
  
    if (hash === signature) {
      return res.status(200).send(echostr);
    }
  } catch (e) {}
  return res.status(403).send('Forbidden');
}

async function handlePostRequest(req, res) {
  let replyContent = '';
  let message = {};
  try {
    const rawBody = await getRawBody(req);
    const parsedXml = await parser.parseStringPromise(rawBody);
    message = parsedXml.xml || {};

    const fromUser = message.FromUserName;

    if (message.MsgType === 'event' && message.Event === 'subscribe') {
      replyContent =
        `恭喜！你发现了果粉秘密基地\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=付款方式&msgmenuid=付款方式">付款方式</a>\n获取注册地址信息\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=查询TikTok&msgmenuid=1">查询TikTok</a>\n热门地区上架查询\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=榜单美国&msgmenuid=3">榜单美国</a>\n全球免费付费榜单\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=价格YouTube&msgmenuid=2">价格YouTube</a>\n应用价格优惠查询\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=切换美国&msgmenuid=4">切换美国</a>\n应用商店随意切换\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=图标QQ&msgmenuid=5">图标QQ</a>\n获取官方高清图标\n\n更多服务请戳底部菜单栏了解`;
    } else if (message.MsgType === 'text' && typeof message.Content === 'string') {
      const content = message.Content.trim();

      // New: myid
      if (/^myid$/i.test(content)) {
        replyContent = `你的 OpenID：${fromUser}`;
      } else {
        // New: admin VIP management (does not affect normal users)
        // Supported formats:
        //   vip add <openid>   / vip del <openid>
        //   vipadd <openid>    / vipdel <openid>
        //   添加VIP <openid>   / 移除VIP <openid> / 删除VIP <openid>
        const vipMatch =
          content.match(/^vip\s*(add|del)\s+(.+)$/i) ||
          content.match(/^vip(add|del)\s+(.+)$/i) ||
          content.match(/^(添加VIP|移除VIP|删除VIP)\s+(.+)$/i);

        if (vipMatch) {
          if (!isAdmin(fromUser)) {
            replyContent = '无权限执行该操作。';
          } else {
            const opRaw = (vipMatch[1] || '').toLowerCase();
            const targetOpenId = (vipMatch[2] || '').trim();
            const op =
              opRaw === 'add' || vipMatch[1] === '添加VIP' ? 'add'
              : (opRaw === 'del' || vipMatch[1] === '移除VIP' || vipMatch[1] === '删除VIP') ? 'del'
              : null;

            if (!op || !targetOpenId) {
              replyContent = '格式错误。示例：vip add OPENID 或 vip del OPENID';
            } else {
              try {
                await manageVip(op, targetOpenId);
                replyContent = op === 'add'
                  ? `已添加 VIP：${targetOpenId}`
                  : `已移除 VIP：${targetOpenId}`;
              } catch (e) {
                console.error('VIP manage error:', e.message || e);
                replyContent = 'VIP 操作失败，请稍后再试。';
              }
            }
          }
        } else {
          // --- Original commands & logic (kept as-is) ---
          const chartV2Match = content.match(/^榜单\s*(.+)$/i);
          const chartMatch = content.match(/^(.*?)(免费榜|付费榜)$/);
          const priceMatchAdvanced = content.match(/^价格\s*(.+?)\s+([a-zA-Z\u4e00-\u9fa5]+)$/i);
          const priceMatchSimple = content.match(/^价格\s*(.+)$/i);
          const switchRegionMatch = content.match(/^(切换|地区)\s*([a-zA-Z\u4e00-\u9fa5]+)$/i);
          const availabilityMatch = content.match(/^查询\s*(.+)$/i);
          const osAllMatch = /^系统更新$/i.test(content);
          const osUpdateMatch = content.match(/^(iOS|iPadOS|macOS|watchOS|tvOS|visionOS)$/i);
          const iconMatch = content.match(/^图标\s*(.+)$/i);

          // Routing + Limits (only consumes quota on valid commands)
          if (chartV2Match && isSupportedRegion(chartV2Match[1])) {
            const lim = await enforceLimits(fromUser, 'chart');
            replyContent = !lim.allowed ? limitExceededText(lim.limit) : await Handlers.handleChartQuery(chartV2Match[1].trim(), '免费榜');

          } else if (chartMatch && isSupportedRegion(chartMatch[1])) {
            const lim = await enforceLimits(fromUser, 'chart');
            replyContent = !lim.allowed ? limitExceededText(lim.limit) : await Handlers.handleChartQuery(chartMatch[1].trim(), chartMatch[2]);

          } else if (priceMatchAdvanced && isSupportedRegion(priceMatchAdvanced[2])) {
            const lim = await enforceLimits(fromUser, 'price');
            replyContent = !lim.allowed ? limitExceededText(lim.limit) : await Handlers.handlePriceQuery(priceMatchAdvanced[1].trim(), priceMatchAdvanced[2].trim(), false);

          } else if (priceMatchSimple) {
            const lim = await enforceLimits(fromUser, 'price');
            if (!lim.allowed) {
              replyContent = limitExceededText(lim.limit);
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
            const lim = await enforceLimits(fromUser, 'updates_all');
            replyContent = !lim.allowed ? limitExceededText(lim.limit) : await Handlers.handleSimpleAllOsUpdates();

          } else if (osUpdateMatch) {
            const lim = await enforceLimits(fromUser, 'updates_detail');
            if (!lim.allowed) {
              replyContent = limitExceededText(lim.limit);
            } else {
              const platform = osUpdateMatch[1].trim();
              replyContent = await Handlers.handleDetailedOsUpdate(platform);
            }

          } else if (switchRegionMatch && isSupportedRegion(switchRegionMatch[2])) {
            const lim = await enforceLimits(fromUser, 'switch');
            replyContent = !lim.allowed ? limitExceededText(lim.limit) : Handlers.handleRegionSwitch(switchRegionMatch[2].trim());

          } else if (availabilityMatch) {
            const lim = await enforceLimits(fromUser, 'availability');
            replyContent = !lim.allowed ? limitExceededText(lim.limit) : await Handlers.handleAvailabilityQuery(availabilityMatch[1].trim());

          } else if (iconMatch) {
            const appName = iconMatch[1].trim();
            if (appName) {
              const lim = await enforceLimits(fromUser, 'icon');
              replyContent = !lim.allowed ? limitExceededText(lim.limit) : await Handlers.lookupAppIcon(appName);
            }
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
    let data = '';
    req.on('data', (chunk) => {
      data += chunk.toString('utf8');
    });
    req.on('end', () => resolve(data));
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
