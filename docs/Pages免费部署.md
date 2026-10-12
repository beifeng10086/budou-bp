# Cloudflare Pages 免费入口

固定入口：**[https://budou-bp-h5.pages.dev/](https://budou-bp-h5.pages.dev/)**。

2026-10-13 已发布到 Cloudflare Pages 免费项目 `budou-bp-h5`，没有绑定支付卡或购买域名。首次部署版本地址为 `https://450832da.budou-bp-h5.pages.dev`，分享时使用上面的固定入口。

用户提供的三个实际站点 `naiwa-kuaipao.pages.dev`、`naiwaxiaowu.pages.dev` 和 `nailong-dance.pages.dev` 均返回 HTTP 200。旧 BP `workers.dev` 入口仍失败，因此改用 Pages 的免费 `pages.dev` 子域名。

## 架构

- Pages 提供手机网页、头像、图标和资料包。
- Pages 的 `/ws` 和 `/health` 使用现有 Worker 的入口逻辑。
- `ROOMS` 绑定现有 `budou-bp` Worker 的 `Room` Durable Object；通过平台内部绑定调用，玩家浏览器不访问 `workers.dev`。
- 房间权限、流程、计时与持久化继续由已有 Worker 负责。
- `_routes.json` 只让 `/ws` 和 `/health` 调用 Functions，静态图片请求不占用 Functions 的每日请求额度。

## 部署

需要现有 `budou-bp` Worker 和有效 Cloudflare 授权。Worker 的 `Room` 类更新时使用原来的 `npm run deploy`；Pages 不负责部署该类。

```powershell
npx wrangler login --scopes account:read user:read workers:write workers_scripts:write pages:write
npm run deploy:pages
```

第一次部署前，如果项目不存在，创建 Direct Upload 项目：

```powershell
npx wrangler pages project create budou-bp-h5 --production-branch master --cwd pages --force
```

首次创建使用 `--force` 明确创建 Pages 项目，避免当前 CLI 自动转为 Workers 项目。已有项目的后续部署不加 `--force`。

电脑授权页验证失败时，可改为设备授权，在手机访问命令给出的验证网址并输入短效码：

```powershell
npx wrangler login --device --browser=false --scopes account:read user:read workers:write workers_scripts:write pages:write
```

本项目已完成首次创建，后续无需再次创建项目。其他账号首次部署时，若项目名被占用，需要调整 `pages/wrangler.jsonc` 的 `name` 并使用可用名称。

更新网页或资料后再次运行 `npm run deploy:pages`，生产域名保持不变。当前采用本机直接上传，不依赖 GitHub 自动构建。

## 免费边界与验证

不升级 Cloudflare 套餐，不购买域名。Pages 静态请求与 Functions/Workers/DO 是不同的计费资源；Functions 与 Workers 的免费请求合计上限为每天 100,000，Durable Objects 也有单独的免费额度。实际规则以平台当前说明为准，免费不等于无限并发或无限用量。

公网验证记录：

- 首页、`/health` 和官网汇总数据包返回 HTTP 200。
- 320/390/844/1280 像素视口的头像、S/A/B/C 排序、筛选和 BP 图导出共 4 项浏览器测试通过。
- 两个独立浏览器创建及加入房间、房主刷新恢复 1P、双方同步开始 BP 的测试通过。
- 房间协议的席位、第三人拒绝、非房主开始拒绝、回合权限、Ban 同步和断线恢复测试通过。
- 部分公网步骤等待超过本地测试原先的 5 秒上限；测试已按公网设置 20 秒等待，同时修正拒绝连接的清理逻辑。协议测试总耗时约 48 秒，浏览器联机测试约 33 秒，不代表每次玩家操作都需要这些时间。

手机流量与微信尚待用户实测，国内不同网络的可达性需分别验证。

本地使用两个配置同时运行 Pages 和房间 Worker，确保跨 Worker 的房间绑定正确加载：

```powershell
npm run build:pages
Set-Location pages
npx wrangler pages dev --config wrangler.jsonc --config ../wrangler.jsonc --ip 127.0.0.1 --port 8789
```

本地也已通过 Pages 构建、Worker/Pages 类型检查、跨 Worker 房间协议测试及全部 5 项浏览器测试。

参考：

- https://developers.cloudflare.com/pages/functions/bindings/
- https://developers.cloudflare.com/pages/functions/advanced-mode/
- https://developers.cloudflare.com/pages/functions/pricing/
