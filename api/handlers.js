const utils = require('./utils');

// 1. 查更新
exports.handleSimpleAllOsUpdates = async () => {
  try {
    const data = await utils.fetchGdmf();
    if (!data) return '❌ 暂时无法连接到 Apple 服务器，请稍后再试。';

    const releases = utils.collectReleases(data, 'iOS');
    if (!releases || !releases.length) return '📭 暂时没查到更新信息。';
    
    // 取前 5 条
    const latest = releases.slice(0, 5).map(r => 
      `📱 ${r.os} ${r.version} (${r.build})\n📅 ${utils.toBeijingYMD(r.date)}`
    ).join('\n\n');
    
    return `【最新系统更新】\n----------------\n${latest}\n\n回复“更新”获取更多。`;
  } catch (err) {
    console.error(err);
    return '系统繁忙，请稍后再试';
  }
};

// 2. 查价格
exports.handlePriceQuery = async (keyword, region, isCN) => {
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(keyword)}&country=cn&entity=software&limit=1`;
    const data = await utils.getJSON(url);
    
    if (!data.results || !data.results.length) {
      return '🔍 未找到该应用，请检查拼写。';
    }
    
    const app = data.results[0];
    const price = utils.formatPrice(app);
    return `💰 应用：${app.trackName}\n💵 价格：${price}\n----------------\n回复“价格 名字”查询其他。`;
  } catch (err) {
    console.error(err);
    return '查询超时，请重试';
  }
};

// 3. 查图标
exports.lookupAppIcon = async (appName, openId) => {
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(appName)}&country=cn&entity=software&limit=1`;
    const data = await utils.getJSON(url);
    
    if (!data.results || !data.results.length) {
      return '🔍 未找到该应用，请尝试更换关键词。';
    }

    const app = data.results[0];
    // 优先取高清图
    const iconUrl = app.artworkUrl512 || app.artworkUrl100;
    
    return `<a href="${iconUrl}">点击查看【${app.trackName}】的高清图标</a>`;
  } catch (error) {
    console.error('Icon Error:', error);
    return '😵‍💫 图标查询出错了，请稍后再试。';
  }
};
