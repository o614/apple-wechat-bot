// api/wechat.js
const crypto = require('crypto');
const { Parser, Builder } = require('xml2js');
const { isSupportedRegion } = require('./utils');
const { ALL_SUPPORTED_REGIONS } = require('./consts');
const Handlers = require('./handlers');

const WECHAT_TOKEN = process.env.WECHAT_TOKEN;

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

async function handlePostRequest(req, res) {
  let replyContent = '';
  let message = {};
  try {
    const rawBody = await getRawBody(req);
    const parsedXml = await parser.parseStringPromise(rawBody);
    message = parsedXml.xml || {};

    if (message.MsgType === 'event' && message.Event === 'subscribe') {
      replyContent =
        `欢迎关注！这里是果粉实用工具箱\n\n` +
        `你可以直接发送应用名称查询详情，或使用以下功能：\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=榜单美国&msgmenuid=1">榜单查询</a> (查热门应用)\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=价格YouTube&msgmenuid=2">价格查询</a> (查应用价格)\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=系统更新&msgmenuid=3">系统更新</a> (iOS 固件)\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=切换美国&msgmenuid=4">跨区切换</a> (免号看商店)\n\n` +
        `› <a href="weixin://bizmsgmenu?msgmenucontent=图标微信&msgmenuid=5">图标获取</a> (高清源图)\n\n` +
        `直接发送 "微信" 或 "查询微信" 试试看！`;
    } else if (message.MsgType === 'text' && typeof message.Content === 'string') {
      const content = message.Content.trim();
      
      // 正则匹配
      const chartMatch = content.match(/^(.*?)(免费榜|付费榜)$/); 
      const chartV2Match = content.match(/^榜单\s*(.+)$/i); 
      
      const priceMatchAdvanced = content.match(/^价格\s*(.+?)\s+([a-zA-Z\u4e00-\u9fa5]+)$/i); 
      const priceMatchSimple = content.match(/^价格\s*(.+)$/i); 
      
      const switchRegionMatch = content.match(/^(切换|地区)\s*([a-zA-Z\u4e00-\u9fa5]+)$/i); 
      
      const osAllMatch = /^系统更新$/i.test(content);
      const osUpdateMatch = content.match(/^(iOS|iPadOS|macOS|watchOS|tvOS|visionOS)$/i); 
      
      const iconMatch = content.match(/^图标\s*(.+)$/i); 
      
      const detailMatch = content.match(/^((查询|详情)\s*)?(.+)$/i); // 捕获所有文本，用于最后兜底

      // 1. 榜单
      if (chartV2Match && isSupportedRegion(chartV2Match[1])) {
        replyContent = await Handlers.handleChartQuery(chartV2Match[1].trim(), '免费榜');
      } else if (chartMatch && isSupportedRegion(chartMatch[1])) {
        replyContent = await Handlers.handleChartQuery(chartMatch[1].trim(), chartMatch[2]);
      
      // 2. 价格
      } else if (priceMatchAdvanced && isSupportedRegion(priceMatchAdvanced[2])) {
        replyContent = await Handlers.handlePriceQuery(priceMatchAdvanced[1].trim(), priceMatchAdvanced[2].trim(), false);
      } else if (priceMatchSimple) {
        let queryAppName = priceMatchSimple[1].trim();
        let targetRegion = '美国';
        let isDefaultSearch = true;
        // 尝试从尾部提取地区
        for (const countryName in ALL_SUPPORTED_REGIONS) {
          if (queryAppName.endsWith(countryName) && queryAppName.length > countryName.length) {
            targetRegion = countryName;
            queryAppName = queryAppName.slice(0, -countryName.length).trim();
            isDefaultSearch = false; 
            break; 
          }
        }
        replyContent = await Handlers.handlePriceQuery(queryAppName, targetRegion, isDefaultSearch);

      // 3. 系统更新
      } else if (osAllMatch) {
        replyContent = await Handlers.handleSimpleAllOsUpdates();
      } else if (osUpdateMatch) {
        replyContent = await Handlers.handleDetailedOsUpdate(osUpdateMatch[1].trim());

      // 4. 切换
      } else if (switchRegionMatch && isSupportedRegion(switchRegionMatch[2])) {
        replyContent = Handlers.handleRegionSwitch(switchRegionMatch[2].trim());

      // 5. 图标
      } else if (iconMatch) {
        replyContent = await Handlers.lookupAppIcon(iconMatch[1].trim());

      // 6. 详情 (兜底逻辑)
      } else if (detailMatch) {
        // 去掉可能的 "查询" 前缀，保留关键词
        let keyword = content;
        if (content.startsWith('查询') || content.startsWith('详情')) {
             keyword = content.replace(/^(查询|详情)\s*/, '');
        }
        if (keyword) {
            replyContent = await Handlers.handleAppDetails(keyword.trim());
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
