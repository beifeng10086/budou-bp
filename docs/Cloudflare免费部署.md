# Cloudflare 免费部署与维护

当前正式部署方案使用 Cloudflare Workers、Static Assets 和 SQLite-backed Durable Objects。页面、图片和双人 WebSocket 房间由同一个 `workers.dev` HTTPS 地址提供，不需要购买服务器、数据库或域名。

## 本次发布记录

- 正式网址：https://budou-bp.budou-bp-h5.workers.dev
- 健康检查：https://budou-bp.budou-bp-h5.workers.dev/health
- 发布日期：2026-09-19。
- 版本：`96496f23-0699-4cf5-a8d9-8852bb5535a0`，Cloudflare 部署记录确认承接 100% 流量。
- 构建和部署成功，静态资源及 Room Durable Object 绑定已上传。未执行套餐升级或域名购买。
- 公网验收未完成：当前电脑网络直连健康接口超时，WebSocket 测试返回 `ETIMEDOUT`，浏览器测试在首页导航时返回 `ERR_CONNECTION_CLOSED`。本机 DNS 结果异常，使用已有本机代理也未能完成 TLS 握手。
- 此前本地功能测试通过，但不能代替手机公网验证。需要在实际手机 Wi-Fi、移动数据和微信中验证；若目标用户网络无法访问该免费域名，应调整访问入口或托管方案。

## 2026-09-22 复测

2026-09-22 复测：Cloudflare 部署记录仍显示上述版本承接 100% 流量。当前电脑直连 `/health` 在 12 秒后连接超时；浏览器首页导航报 `ERR_CONNECTION_TIMED_OUT`，在线测试未进入创建房间步骤；WebSocket 协议测试报 `ETIMEDOUT`。系统 DNS 的 A 记录为 `154.83.14.134`，阿里加密 DNS 查询返回 `69.63.176.143`，结果异常。原本机代理 `127.0.0.1:7890` 本次无法连接。公网验收仍未通过；这些结果仅代表本次电脑网络，不能替代实际手机运营商网络测试。本次没有重新部署或修改应用代码。

## 费用边界

- 使用 Cloudflare Workers Free，不启用付费套餐，不绑定付费域名。
- 免费额度以 Cloudflare 控制台当日显示为准；额度不是“无限用户”，访问量超过免费上限后服务可能暂时受限。
- `workers.dev` 是平台免费子域名。中国大陆不同运营商、地区以及微信内置浏览器的可达性需要实测，Cloudflare 免费服务不保证大陆网络质量。
- 房间保存 6 小时；浏览器刷新、锁屏或短时断网后，可凭本机令牌恢复原来的 1P/2P 席位。

## 首次发布

在项目目录运行：

```powershell
Set-Location 'C:\Users\29851\Documents\ChatGPT\武斗bp'
npm install
npm run build
npx wrangler login
```

`wrangler login` 会打开 Cloudflare 官方授权页。只在浏览器中确认授权，不要把密码、邮箱验证码、恢复码、API Token 或付款信息发给其他人。

授权成功后运行：

```powershell
npm run deploy
```

命令完成时会显示类似下面的固定地址：

```text
https://budou-bp.<你的-workers子域>.workers.dev
```

只要不删除这个 Worker 或修改 `wrangler.jsonc` 中的 `name`，以后更新仍使用同一个网址。

## 发布后检查

1. 打开 `https://你的地址/health`，应看到 `{"ok":true,"service":"budou-bp-cloudflare"}`。
2. 手机 A 创建共享房间，把邀请链接发给手机 B。
3. B 应显示为 2P；A 刷新后仍应恢复为 1P。
4. 检查双方禁选同步、忍者头像、秘卷、通灵、BO3 下一局和保存结果图。
5. 再用移动数据和微信内置浏览器各测试一次，避免只验证同一 Wi-Fi。

## 后续更新

代码或资料更新后，在同一目录运行：

```powershell
npm run deploy
```

更新官网资料时先运行：

```powershell
npm run data:sync -- --refresh
npm run test:catalog
npm run deploy
```

部署会重新构建 `dist` 并上传静态资料，网址不变。正在进行的房间状态由 Durable Object 持久化；部署通常不会清空房间，但仍应尽量避开集中比赛时段发布。

## 本地验证

```powershell
npm run build
npm run typecheck:worker
npx wrangler dev --local --ip 127.0.0.1 --port 8788
```

另开一个 PowerShell 运行协议测试：

```powershell
npm run test:cloudflare-room
```

页面测试可让 Playwright 指向本地 Worker：

```powershell
$env:BP_BASE_URL='http://127.0.0.1:8788'
npm run test:browser
```

## 管理与故障处理

- 查看线上日志：`npx wrangler tail`
- 查看当前登录账号：`npx wrangler whoami`
- 重新发布：`npm run deploy`
- 退出本机授权：`npx wrangler logout`
- 首页能开但房间失败：先访问 `/health`，再用 `npx wrangler tail` 查看 `/ws` 错误。
- 资料或头像缺失：运行 `npm run test:catalog`，确认后重新部署。
- 出现免费额度提醒：先在 Cloudflare 控制台确认用量；不要直接升级付费套餐。

Cloudflare 控制台里不需要手工新建 Worker、Durable Object 或数据库。`wrangler.jsonc` 的首次部署会自动创建并绑定这些资源。

## 备用方案

原 Railway/Node 部署说明保留在 [公网部署.md](公网部署.md)，但它不是当前默认方案，也不承诺免费。`server/index.ts` 继续作为本地或 Node 主机备用服务；正式免费公网版本以 Cloudflare Worker 为准。
