# WeChat Apple Assistant (微信 Apple 助手) 🍎

这是一个运行在 Serverless 环境（如 Vercel）下的微信公众号后台服务。它专为 Apple 生态用户设计，提供 App Store 榜单查询、价格查询、系统更新监测以及高清图标提取等实用功能。

<table>
  <tr>
    <td width="25%"><img src="https://github.com/user-attachments/assets/1d66b0d9-9a2d-4c83-80e0-96a4444cb9c1"></td>
    <td width="25%"><img src="https://github.com/user-attachments/assets/fcb011d9-5a63-4478-8593-ce2f4085875c"></td>
    <td width="25%"><img src="https://github.com/user-attachments/assets/a0f28df6-c922-4527-a59c-db87a31d9ec3"></td>
    <td width="25%"><img src="https://github.com/user-attachments/assets/fdf40a9b-66a9-4ae4-9551-9ac8b469cab1"></td>
  </tr>
</table>
<table>
  <tr>
    <td width="33.3%"><img src="https://github.com/user-attachments/assets/90a5e12b-bbef-4c32-ab28-31ec378142ba"></td>
    <td width="33.3%"><img src="https://github.com/user-attachments/assets/2851cab2-a412-4087-bc00-58d78db356a7"></td>
    <td width="33.3%"><img src="https://github.com/user-attachments/assets/4c463be1-a320-4627-94ed-bf6e5b82c8b0"></td>
  </tr>
</table>


## ✨ 主要功能

* **📊 榜单查询**：支持查询全球主要国家/地区的 App Store 免费榜和付费榜 Top 10。
    * 指令：`榜单 美国`、`日本免费榜`
* **💰 价格比价**：查询 App 在特定国家的价格，支持模糊搜索。
    * 指令：`价格 Minecraft 美国`、`价格 微信`（默认美区）
* **🌍 跨区助手**：生成免登录切换 App Store 地区的链接（仅浏览）。
    * 指令：`切换 土耳其`、`地区 台湾`
* **🔍 上架查询**：一键检测 App 是否在全球热门地区（美/港/台/日/韩等）上架。
    * 指令：`查询 TikTok`
* **🔄 系统更新**：实时监测 iOS, macOS, watchOS 等系统的最新正式版、Beta 版和 RC 版状态。
    * 指令：`系统更新`、`更新 iOS`
* **🖼 图标提取**：获取 App 的 1024x1024 高清原始图标。
    * 指令：`图标 微信`

## 🛠 部署指南 (Deploy)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/o614/apple-wechat-bot)

本项目非常适合部署在 [Vercel](https://vercel.com/) 上。

### 1. 准备工作
* 注册一个 GitHub 账号并 Fork 本仓库。
* 注册一个 Vercel 账号。
* 拥有一个微信公众号（订阅号或服务号均可）。

### 2. 部署到 Vercel
1.  在 Vercel 控制台点击 **"Add New..."** -> **"Project"**。
2.  导入你刚才 Fork 的 GitHub 仓库。
3.  在 **"Environment Variables"** (环境变量) 设置中，添加以下变量：
    * `WECHAT_TOKEN`: 你在微信公众号后台设置的 Token（自定义字符串，用于验证）。
4.  点击 **"Deploy"**。

### 3. 配置微信公众号
1.  部署成功后，复制 Vercel 分配的域名（例如 `https://your-project.vercel.app`）。
2.  进入 [微信公众平台](https://mp.weixin.qq.com/) -> **设置与开发** -> **基本配置**。
3.  点击 **"修改配置"**：
    * **URL**: `https://你的域名/api/wechat` (注意：通常需要加上代码中对应的路径，如果你的入口文件在 api/wechat.js)
    * **Token**: 填写你在 Vercel 环境变量里设置的那个 `WECHAT_TOKEN`。
    * **EncodingAESKey**: 随机生成即可。
    * **消息加解密方式**: 推荐选择“明文模式”或“兼容模式”。
4.  点击 **"提交"**，如果显示“提交成功”，则部署完成！🎉

## 📂 项目结构

```text
/
├── api/
│   ├── wechat.js    # 核心逻辑处理 (Core Logic)
│   └── consts.js    # 静态数据配置 (Constants & Config)
├── package.json     # 项目依赖
└── README.md        # 说明文档
``` 
## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=o614/apple-wechat-bot&type=date&legend=top-left)](https://www.star-history.com/#o614/apple-wechat-bot&type=date&legend=top-left)
