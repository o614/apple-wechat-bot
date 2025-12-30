const { parseStringPromise } = require('xml2js');
const handlers = require('./handlers');
const utils = require('./utils');
const { isSupportedRegion } = require('./utils'); // 确保能用到地区检查工具

// ==========================================
// 🎛️ 配置表 (VIP / 限流)
// ==========================================
const LIMIT_CONFIG = {
  // 👑 你的 OpenID (超级管理员)
  ADMIN_OPENID: 'o4UNGw6r9OL9q_4jRAfed_jnvXh8', 

  // 全局限制 (每日总次数)
  GLOBAL_DAILY_LIMIT: 30, 

  // 功能限制 (每日次数)
  // 0: 只受大闸限制 | -1: 豁免(免费)
  FEATURES: {
    'icon': 3,     // 🔴 图标 (3次)
    'search': 10,  // 🟡 查询/价格 (10次)
    'rank': 10,    // 🟡 榜单 (10次)
    'update': 15,  // 🔵 系统更新 (15次)
    'switch': -1,  // 🟢 切换地区 (豁免)
    'myid': -1     // 🛡️ 查ID (豁免)
  }
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body) {
      if (typeof req.body === 'string') return resolve(req.body);
      if (Buffer.isBuffer(req.body)) return resolve(req.body.toString());
      return resolve(JSON.stringify(req.body));
    }
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => { resolve(data); });
    req.on('error', err => { reject(err); });
  });
}

module.exports = async (req, res) => {
  try {
    // 1. 微信握手验证
    if (req.method === 'GET') return res.status(200).send(req.query.echostr);

    // 2. 获取数据
    const rawContent = await getRawBody(req);
    if (!rawContent) return res.status(200).send('success');

    // 3. 解析 XML
    const result = await parseStringPromise(rawContent);
    const xml = result.xml;
    const toUser = xml.ToUserName[0];
    const fromUser = xml.FromUserName[0];
    const msgType = xml.MsgType ? xml.MsgType[0] : '';
    const eventType = xml.Event ? xml.Event[0] : '';
    const content = xml.Content ? xml.Content[0].trim() : '';

    console.log(`[Msg] User: ${fromUser}, Content: ${content}`);

    // 定义回复函数
    const reply = (text) => {
      const now = Math.floor(Date.now() / 1000);
      res.setHeader('Content-Type', 'application/xml');
      res.status(200).send(`
        <xml>
          <ToUserName><![CDATA[${fromUser}]]></ToUserName>
          <FromUserName><![CDATA[${toUser}]]></FromUserName>
          <CreateTime>${now}</CreateTime>
          <MsgType><![CDATA[text]]></MsgType>
          <Content><![CDATA[${text}]]></Content>
        </xml>
      `);
    };

    // 🚦 核心拦截器 (VIP & 限流)
    const checkLimits = async (actionType) => {
      // 1. 超级管理员直接放行
      if (fromUser === LIMIT_CONFIG.ADMIN_OPENID) {
        console.log(`[Admin] 管理员 ${fromUser} 无视限制。`);
        return true; 
      }

      const featureLimit = LIMIT_CONFIG.FEATURES[actionType];
      if (featureLimit === -1) return true; // 豁免功能

      // 2. 查大闸 (总次数)
      const globalAllowed = await utils.checkUsageLimit(fromUser, 'global_limit', LIMIT_CONFIG.GLOBAL_DAILY_LIMIT);
      if (!globalAllowed) {
        reply(`🚫 今日总互动已达上限 (${LIMIT_CONFIG.GLOBAL_DAILY_LIMIT}次)。\n成为VIP会员可解除限制。`);
        return false;
      }

      // 3. 查小闸 (功能次数)
      if (featureLimit > 0) {
        const featureAllowed = await utils.checkUsageLimit(fromUser, `feat_${actionType}`, featureLimit);
        if (!featureAllowed) {
          reply(`🚫 该功能今日额度已用完 (${featureLimit}次)。`);
          return false;
        }
      }
      return true;
    };

    // ==========================================
    // 🕹️ 路由逻辑 (旧版精准正则 + 新版限流)
    // ==========================================

    // 0. 特殊指令：付款方式 (静默处理)
    // 如果用户发“付款方式”，直接回 success，不发 XML，让微信后台自动回复生效
    if (content === '付款方式') {
      return res.status(200).send('success');
    }

    // 1. 管理员指令 (VIP 管理)
    if (fromUser === LIMIT_CONFIG.ADMIN_OPENID && content.toLowerCase().startsWith('vip')) {
      const parts = content.split(' ');
      if (parts.length === 3) { 
        const result = await utils.manageVip(parts[1], parts[2]);
        return reply(result);
      }
    }

    // 2. 关注事件 (欢迎语)
    if (msgType === 'event' && eventType === 'subscribe') {
      const welcomeText = 
        `恭喜！你发现了果粉秘密基地\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=付款方式&msgmenuid=付款方式">付款方式</a>\n获取注册地址信息\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=查询TikTok&msgmenuid=1">查询TikTok</a>\n热门地区上架查询\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=榜单美国&msgmenuid=3">榜单美国</a>\n全球免费付费榜单\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=价格YouTube&msgmenuid=2">价格YouTube</a>\n应用价格优惠查询\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=切换美国&msgmenuid=4">切换美国</a>\n应用商店随意切换\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=图标QQ&msgmenuid=5">图标QQ</a>\n获取官方高清图标\n\n更多服务请戳底部菜单栏了解`;
      return reply(welcomeText);
    }

    // 3. MyID (豁免)
    if (content.toLowerCase() === 'myid') {
      if (await checkLimits('myid')) return reply(`你的 OpenID 是：\n${fromUser}`);
    }

    // ==================== 业务正则匹配 ====================

    // 4. 切换地区 (豁免)
    // 匹配: "切换美国", "地区日本"
    const switchMatch = content.match(/^(?:切换|地区)\s*(.+)$/i);
    if (switchMatch) {
      if (await checkLimits('switch')) {
        const region = switchMatch[1].trim();
        const result = handlers.handleRegionSwitch(region);
        return reply(result);
      }
      return; 
    }

    // 5. 榜单查询 (限流: rank)
    // 匹配: "榜单美国", "美国免费榜"
    const chartMatch = content.match(/^榜单\s*(.+)$/i) || content.match(/^(.+)(免费榜|付费榜)$/);
    if (chartMatch) {
      if (await checkLimits('rank')) {
        // 如果是 "榜单美国"，默认查免费榜；如果是 "美国免费榜"，提取地区
        const region = chartMatch[1].trim();
        const type = chartMatch[2] || '免费榜'; // 默认免费榜
        const result = await handlers.handleChartQuery(region, type);
        return reply(result);
      }
      return;
    }

    // 6. 上架查询 (限流: search) - 修复重点！！
    // 匹配: "查询TikTok" -> 查的是可下载地区 (handleAvailabilityQuery)
    const availabilityMatch = content.match(/^查询\s*(.+)$/i);
    if (availabilityMatch) {
      if (await checkLimits('search')) {
        const appName = availabilityMatch[1].trim();
        const result = await handlers.handleAvailabilityQuery(appName);
        return reply(result);
      }
      return;
    }

    // 7. 价格查询 (限流: search)
    // 匹配: "价格YouTube" -> 查的是价格 (handlePriceQuery)
    const priceMatch = content.match(/^价格\s*(.+)$/i);
    if (priceMatch) {
      if (await checkLimits('search')) {
        const appName = priceMatch[1].trim();
        // 默认查中国区价格，保持旧版逻辑
        const result = await handlers.handlePriceQuery(appName, '中国', true);
        return reply(result);
      }
      return;
    }

    // 8. 图标查询 (限流: icon)
    // 匹配: "图标QQ"
    const iconMatch = content.match(/^图标\s*(.+)$/i);
    if (iconMatch) {
      if (await checkLimits('icon')) {
        const appName = iconMatch[1].trim();
        const result = await handlers.lookupAppIcon(appName, fromUser);
        return reply(result);
      }
      return;
    }

    // 9. 系统更新 - 概览 (限流: update)
    // 匹配: "更新", "update"
    if (content === '更新' || content.toLowerCase() === 'update') {
      if (await checkLimits('update')) {
        const result = await handlers.handleSimpleAllOsUpdates();
        return reply(result);
      }
      return;
    }

    // 10. 系统更新 - 详细 (限流: update)
    // 匹配: "iOS", "iPadOS", "macOS" 等
    const osMatch = content.match(/^(ios|ipados|macos|watchos|tvos|visionos)$/i);
    if (osMatch) {
      if (await checkLimits('update')) {
        const platform = osMatch[1];
        const result = await handlers.handleDetailedOsUpdate(platform);
        return reply(result);
      }
      return;
    }

    // 11. 兜底 (静默)
    // 没匹配到任何指令，回 success 不说话
    return res.status(200).send('success');

  } catch (error) {
    console.error('[Fatal Error]', error);
    res.status(200).send('success');
  }
};
