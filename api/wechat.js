const { parseStringPromise } = require('xml2js');
const handlers = require('./handlers');

module.exports = async (req, res) => {
  try {
    const { body } = req;
    if (req.method === 'GET') return res.status(200).send(req.query.echostr);

    const result = await parseStringPromise(body);
    const xml = result.xml;
    const toUser = xml.ToUserName[0];
    const fromUser = xml.FromUserName[0]; // 1. 提取 OpenID
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

    if (content === '更新') {
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
      // 👇👇👇 你的旧代码肯定漏了这里！必须把 fromUser 传进去 👇👇👇
      const result = await handlers.lookupAppIcon(appName, fromUser);
      return reply(result);
    }
    else {
      return reply('收到！试试发送“图标 微信”？');
    }
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Error');
  }
};
