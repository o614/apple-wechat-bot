const { parseStringPromise } = require('xml2js');
const handlers = require('./handlers');
const utils = require('./utils');

// ==========================================
// 🎛️ 配置表
// ==========================================
const LIMIT_CONFIG = {
  // 👑 超级管理员 OpenID (改成你自己的！用 myid 查一下)
  ADMIN_OPENID: 'o4UNGw6r9OL9q_4jRAfed_jnvXh8', // 👈 必须改成你自己的 ID！！！

  GLOBAL_DAILY_LIMIT: 30, 
  FEATURES: {
    'icon': 3,
    'search': 10,
    'rank': 10,
    'update': 15,
    'switch': -1,
    'static': -1,
    'myid': -1
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

    // 🚦 拦截逻辑 (VIP 会在 utils 里直接通过)
    const checkLimits = async (actionType) => {
      const featureLimit = LIMIT_CONFIG.FEATURES[actionType];
      if (featureLimit === -1) return true; 

      const globalAllowed = await utils.checkUsageLimit(fromUser, 'global_limit', LIMIT_CONFIG.GLOBAL_DAILY_LIMIT);
      if (!globalAllowed) {
        reply(`🚫 今日互动已达上限。VIP会员请联系管理员解除限制。`);
        return false;
      }

      if (featureLimit > 0) {
        const featureAllowed = await utils.checkUsageLimit(fromUser, `feat_${actionType}`, featureLimit);
        if (!featureAllowed) {
          reply(`🚫 该功能今日额度已用完。VIP会员无限制。`);
          return false;
        }
      }
      return true;
    };

    // ==========================================
    // 👮‍♂️ 管理员专属指令 (隐形后门)
    // ==========================================
    // 格式：vip add oXXXXX
    if (fromUser === LIMIT_CONFIG.ADMIN_OPENID && content.toLowerCase().startsWith('vip')) {
      const parts = content.split(' ');
      // parts[0]=vip, parts[1]=add/del, parts[2]=openid
      if (parts.length === 3) {
        const cmd = parts[1];
        const targetId = parts[2];
        const result = await utils.manageVip(cmd, targetId);
        return reply(result);
      }
    }

    // ... 下面是常规业务逻辑 (保持你之前的代码) ...
    
    // 1. 关注
    if (msgType === 'event' && eventType === 'subscribe') {
      // ... 你的欢迎语代码 ...
      return reply('欢迎关注...'); // 简写了，请用你原来的
    }
    
    // 2. MyID
    if (content.toLowerCase() === 'myid') {
      if (await checkLimits('myid')) return reply(`你的 OpenID 是：\n${fromUser}`);
    }
    
    // ... 其他更新、价格、图标等逻辑 ...
    // (请把你之前 api/wechat.js 里的业务逻辑部分原样复制在这里)
    
    // 兜底
    else {
      return res.status(200).send('success');
    }

  } catch (error) {
    console.error('[Error]', error);
    res.status(200).send('success');
  }
};
