// server/ext.js —— 服务端扩展路由入口
// 扩展路由按主题放在 server/features/*.js；本仓自带一个空的扩展入口，
// 需要时在此挂载自己的处理器，不改 server.js 主流程。
'use strict';

// 返回 true 表示该扩展已处理请求；false 交回主服务
async function handle(req, res, pathname, url) {
  return false;
}

module.exports = { handle };
