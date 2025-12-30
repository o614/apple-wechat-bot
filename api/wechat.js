const { parseStringPromise } = require('xml2js');
const handlers = require('./handlers');

// 保持手动读取数据的函数不动
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
    const fromUser = xml.FromUserName[0]; // 用户的 OpenID
    const msgType = xml.MsgType ? xml.MsgType[0] : '';
    const eventType = xml.Event ? xml.Event[0] : '';
    const content = xml.Content ? xml.Content[0].trim() : '';

    console.log(`[Message] User: ${fromUser}, Type: ${msgType}, Event: ${eventType}, Content: ${content}`);

    const reply = (text) => {
      const now = Math.floor(Date.now() / 1000);
      const xmlResponse = `
        <xml>
          <ToUserName><![CDATA[${fromUser}]]></ToUserName>
          <FromUserName><![CDATA[${toUser}]]></FromUserName>
          <CreateTime>${now}</CreateTime>
          <MsgType><![CDATA[text]]></MsgType>
          <Content><![CDATA[${text}]]></Content>
        </xml>
      `;
      res.setHeader('Content-Type', 'application/xml');
      res.status(200).send(xmlResponse);
    };

    // 1. 处理关注事件
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

    // 2. 处理 myid 指令
    if (content.toLowerCase() === 'myid') {
      return reply(`你的 OpenID 是：\n${fromUser}`);
    }

    // 3. 其他指令
    if (content === '更新' || content.toLowerCase() === 'update') {
      const result = await handlers.handleSimpleAllOsUpdates();
      return reply(result);
    } 
    else if (content.startsWith('价格')) {
      const key = content.replace('价格', '').trim();
      const result = await handlers.handlePriceQuery(key, '中国', true);
      return reply(result);
    } 
    else if (content.startsWith('图标')) {
      const appName = content.replace('图标', '').trim();
      const result = await handlers.lookupAppIcon(appName, fromUser);
      return reply(result);
    }
    else {
      // 👇👇👇 改动在这里 👇👇👇
      // 如果没有匹配到任何指令，直接回 'success'。
      // 微信收到 'success' 后，不会给用户发任何消息，也不会报错。
      // 这样就不会干扰你公众号的其他功能了。
      return res.status(200).send('success');
    }

  } catch (error) {
    console.error('[Error]', error);
    // 报错时也回 success，保持静默，防止微信服务器一直重试
    res.status(200).send('success');
  }
};
