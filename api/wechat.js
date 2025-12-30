const { parseStringPromise } = require('xml2js');
const handlers = require('./handlers');
const utils = require('./utils');

// ==========================================
// 🎛️ 配置表
// ==========================================
const LIMIT_CONFIG = {
  // 👑 你的 OpenID (超级管理员)
  ADMIN_OPENID: 'o4UNGw6r9OL9q_4jRAfed_jnvXh8', 

  // 全局限制
  GLOBAL_DAILY_LIMIT: 30, 

  // 功能限制
  FEATURES: {
    'icon': 3,     // 图标
    'search': 10,  // 上架查询/价格
    'rank': 10,    // 榜单
    'update': 15,  // 更新
    'switch': -1,  // 切换 (豁免)
    'static': -1,  // 静态回复 (豁免)
    'myid': -1     // 查ID (豁免)
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
    if (req.method === 'GET') return res.status(200).send(req.query.echostr);

    const rawContent = await getRawBody(req);
    if (!rawContent) return res.status(200).send('success');

    const result = await parseStringPromise(rawContent);
    const xml = result.xml;
    const toUser = xml.ToUserName[0];
    const fromUser = xml.FromUserName[0];
    const msgType = xml.MsgType ? xml.MsgType[0] : '';
    const eventType = xml.Event ? xml.Event[0] : '';
    const content = xml.Content ? xml.Content[0].trim() : '';

    console.log(`[Msg] User: ${fromUser}, Content: ${content}`);

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

    // 🚦 拦截检查器
    const checkLimits = async (actionType) => {
      // 1. 管理员免检
      if (fromUser === LIMIT_CONFIG.ADMIN_OPENID) return true;

      const featureLimit = LIMIT_CONFIG.FEATURES[actionType];
      if (featureLimit === -1) return true; 

      // 2. 查大闸
      const globalAllowed = await utils.checkUsageLimit(fromUser, 'global_limit', LIMIT_CONFIG.GLOBAL_DAILY_LIMIT);
      if (!globalAllowed) {
        reply(`🚫 今日互动已达上限 (${LIMIT_CONFIG.GLOBAL_DAILY_LIMIT}次)。\nVIP会员无限制。`);
        return false;
      }

      // 3. 查小闸
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
    // 🕹️ 路由逻辑 (严格按照你旧版功能的正则逻辑)
    // ==========================================

    // 0. 静默处理：付款方式
    // 直接返回 success，不回复任何内容，让微信后台接管
    if (content === '付款方式') {
      return res.status(200).send('success');
    }

    // 1. 管理员指令
    if (fromUser === LIMIT_CONFIG.ADMIN_OPENID && content.toLowerCase().startsWith('vip')) {
      const parts = content.split(' ');
      if (parts.length === 3) {
        const result = await utils.manageVip(parts[1], parts[2]);
        return reply(result);
      }
    }

    // 2. 关注欢迎语
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

    if (content.toLowerCase() === 'myid') {
      if (await checkLimits('myid')) return reply(`你的 OpenID 是：\n${fromUser}`);
    }

    // ==================== 正则路由核心 ====================

    // 3. 上架查询 (Match: 查询TikTok) -> handleAvailabilityQuery
    // ⚠️ 之前错在这里，这里必须去调“上架查询”，不能调价格
    const availabilityMatch = content.match(/^(?:查询|上架)\s*(.+)$/i);
    if (availabilityMatch && !content.startsWith('价格')) { // 排除“价格查询”防止冲突
      if (await checkLimits('search')) {
        const appName = availabilityMatch[1].trim();
        const result = await handlers.handleAvailabilityQuery(appName);
        return reply(result);
      }
      return;
    }

    // 4. 价格查询 (Match: 价格YouTube, 价格Minecraft日本) -> handlePriceQuery
    const priceMatch = content.match(/^(?:价格|price)\s*(.+)$/i);
    if (priceMatch) {
      if (await checkLimits('search')) {
        let key = priceMatch[1].trim();
        // 尝试提取地区，例如 "Minecraft日本"
        let region = '中国';
        // 简单的末尾地区提取 (复刻旧版智能感应)
        const regionMatch = key.match(/(.+)[\s](.+)$/) || key.match(/(.+)(中国|美国|日本|香港|台湾|英国|韩国)$/);
        if (regionMatch) {
            key = regionMatch[1].trim();
            region = regionMatch[2].trim();
        }
        const result = await handlers.handlePriceQuery(key, region, true);
        return reply(result);
      }
      return;
    }

    // 5. 榜单查询 (Match: 榜单美国, 美国免费榜) -> handleChartQuery
    const chartMatch = content.match(/^榜单\s*(.+)$/i) || content.match(/^(.+)(免费榜|付费榜)$/);
    if (chartMatch) {
      if (await checkLimits('rank')) {
        const region = chartMatch[1].trim();
        const type = chartMatch[2] || '免费榜';
        const result = await handlers.handleChartQuery(region, type);
        return reply(result);
      }
      return;
    }

    // 6. 切换地区 (Match: 切换美国) -> handleRegionSwitch
    const switchMatch = content.match(/^(?:切换|地区)\s*(.+)$/i);
    if (switchMatch) {
      if (await checkLimits('switch')) {
        const region = switchMatch[1].trim();
        const result = handlers.handleRegionSwitch(region);
        return reply(result);
      }
      return;
    }

    // 7. 图标查询 (Match: 图标QQ) -> lookupAppIcon
    const iconMatch = content.match(/^图标\s*(.+)$/i);
    if (iconMatch) {
      if (await checkLimits('icon')) {
        const appName = iconMatch[1].trim();
        const result = await handlers.lookupAppIcon(appName, fromUser); // 传入OpenID
        return reply(result);
      }
      return;
    }

    // 8. 系统更新 (Match: 更新, iOS, iPadOS...) -> handleSimple/Detailed
    const osUpdateSimple = content.match(/^(?:更新|update)$/i);
    const osUpdateDetail = content.match(/^(ios|ipados|macos|watchos|tvos|visionos)$/i);
    
    if (osUpdateSimple) {
      if (await checkLimits('update')) {
        const result = await handlers.handleSimpleAllOsUpdates();
        return reply(result);
      }
      return;
    }
    
    if (osUpdateDetail) {
      if (await checkLimits('update')) {
        const platform = osUpdateDetail[1];
        const result = await handlers.handleDetailedOsUpdate(platform);
        return reply(result);
      }
      return;
    }

    // 9. 兜底
    return res.status(200).send('success');

  } catch (error) {
    console.error('[Fatal Error]', error);
    res.status(200).send('success');
  }
};
