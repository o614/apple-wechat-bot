// api/wechat.js (临时验证专用)
const crypto = require('crypto');

// 必须和你 Vercel 环境变量里的 WECHAT_TOKEN 一致
const WECHAT_TOKEN = process.env.WECHAT_TOKEN; 

module.exports = async (req, res) => {
  // 只处理微信的验证请求
  try {
    const { signature, timestamp, nonce, echostr } = req.query;
    // 如果没有传 echostr，直接返回空，防止报错
    if (!echostr) return res.status(200).send('Hello WeChat');

    const params = [WECHAT_TOKEN || '', timestamp, nonce].sort();
    const hash = crypto.createHash('sha1').update(params.join('')).digest('hex');

    if (hash === signature) {
      // 验证通过，原样返回 echostr
      return res.status(200).send(echostr);
    } else {
      return res.status(401).send('Invalid Signature');
    }
  } catch (e) {
    return res.status(500).send('Error');
  }
};
