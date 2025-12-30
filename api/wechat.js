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
    const fromUser = xml.FromUserName[0]; // 👈 这个就是用户的 OpenID
    const msgType = xml.MsgType ? xml.MsgType[0] : '';
    const eventType = xml.Event ? xml.Event[0] : '';
    const content = xml.Content ? xml.Content[0].trim() : '';

    console.log(`[Message] User: ${fromUser}, Type: ${msgType}, Event: ${eventType}`);

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

    // 👇👇👇 这里的欢迎语加上了 OpenID 👇👇👇
    if (msgType === 'event' && eventType === 'subscribe') {
      const welcomeText = 
        `用户 ID：${fromUser}\n\n` +  // 👈 新增：显示 OpenID
        `恭喜！你发现了果粉秘密基地\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=付款方式&msgmenuid=付款方式">付款方式</a>\n获取注册地址信息\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=查询TikTok&msgmenuid=1">查询TikTok</a>\n热门地区上架查询\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=榜单美国&msgmenuid=3">榜单美国</a>\n全球免费付费榜单\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=价格YouTube&msgmenuid=2">价格YouTube</a>\n应用价格优惠查询\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=切换美国&msgmenuid=4">切换美国</a>\n应用商店随意切换\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=图标QQ&msgmenuid=5">图标QQ</a>\n获取官方高清图标\n\n更多服务请戳底部菜单栏了解`;
      
      return reply(welcomeText);
    }

    // 普通指令逻辑 (保持不变)
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
      return reply('收到！试试点击菜单里的功能，或者发送“图标 微信”？');
    }

  } catch (error) {
    console.error('[Error]', error);
    res.status(200).send('success');
  }
};
