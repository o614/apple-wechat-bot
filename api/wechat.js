// api/wechat.js (核弹级盲通版)
module.exports = (req, res) => {
  // 1. 如果是微信验证请求 (带 echostr)，直接原样返回，不验证 token！
  if (req.query.echostr) {
    return res.send(req.query.echostr);
  }
  
  // 2. 其他情况 (浏览器访问)
  return res.send('Vercel is working! Now go to WeChat Admin.');
};
