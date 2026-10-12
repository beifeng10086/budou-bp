# 武斗 BP 练习室

这是一个非官方移动端 BP 练习工具。已接入官网公开资料与本地头像、图标，支持本机演练和双人房间。房间优先使用 WebSocket，首次连接失败、超时或连接中断时自动切换为同源 HTTPS 备用通道。

固定公网入口：**[https://budou-bp-h5.pages.dev/](https://budou-bp-h5.pages.dev/)**。2026-10-13 已部署到 Cloudflare Pages 免费项目，没有绑定支付卡或购买域名。后续更新仍使用此网址；通过房间链接或房间码邀请另一名玩家。

Pages 静态页面通过内部绑定复用现有 Worker 的持久房间，浏览器只连接 Pages 域名。公网首页、健康检查和数据包返回 HTTP 200；320/390/844/1280 像素视口的头像、排序、筛选及结果图导出测试，以及双浏览器房间加入、开始和刷新恢复测试均已通过。房间协议的席位、权限和第三人拒绝测试通过。公网联机测试出现数秒等待，需继续实测手机流量及微信访问。部署、免费额度与更新命令见 [Pages 部署说明](docs/Pages免费部署.md)。

代码已上传到 [GitHub 仓库](https://github.com/beifeng10086/budou-bp)，Gitee 另有私有备份。旧 `workers.dev` 玩家入口无法访问；Render 选择 Free 套餐仍要求绑卡并进行 1 美元临时验证，已取消。历史记录保留在 [Render 部署记录](docs/Render免费部署.md) 和 [Worker 部署记录](docs/Cloudflare免费部署.md)。

## 官网资料与图片

首页自动加载 `public/data/catalog-index.json` 中的数据包，无需玩家手工导入。默认包按指定截止日期过滤尚未上线的忍者；原始列表中的所有忍者仍保存在数据库中。

- `data/catalog.sqlite`：SQLite 资料库，保存官方 ID、名称、别名、来源、上线日期、本地图片路径及数据包快照。图片使用文件存储，不把二进制塞进 JSON。
- `public/assets/catalog/`：下载并压缩到最长边 160px 的 WebP 头像和图标，同源访问，支持 BP 结果图导出。
- `public/data/official-collected-YYYY-MM-DD.json`：直接可用的数据包。
- `public/data/catalog-report.json`：采集数量、失败条目、排除的预告忍者和覆盖范围报告。
- `data/source-cache/`：官网详情缓存，重复运行时复用，可用 `--refresh` 更新。

当前忍者来源是官网列表。秘卷和通灵由全部忍者详情中的推荐搭配去重汇总，尚未核实是否覆盖全游戏，也没有确认每条推荐都能在比赛中独立选用。数据包明确标记为“官网资料汇总池（非赛事池）”，不是官方比赛名单。官网 ID 用于去重，保留角色形态，不按同名合并。

自动采集（Node.js 22.13+，先安装开发依赖）：

```bash
npm run data:sync -- --input "E:/下载/ninja_list.json" --date 2026-09-19
# 后续自动从官网重新获取列表和详情，不需要逐项录入：
npm run data:sync -- --refresh
```

采集器以 4 路并发下载、失败重试、校验图片解码，并生成数据库和前端数据包。下载的 JSONP 只解析数据，不执行代码。不同日期的数据包会保留在版本目录中；同一日期重跑会更新该日期快照。来源链接和采集时间保留在资料中；采集行为不代表获得素材再分发授权。

本地开发页面会直接读取更新后的 `public/` 文件；生产服务使用 `dist/`，同步后运行 `npm run build` 即可把新资料和图片更新到生产页面。SQLite 资料库与房间存储相互独立；Cloudflare 生产版的房间使用 Durable Objects 持久化，本地 Node 备用服务仍使用内存房间。

校验数据和图片：`npm run test:catalog`。生产页面回归：先 `npm run build`，再 `npm run test:browser`（需安装 Playwright Chromium）。

## 已实现规则

- 数据包提供完整的忍者、秘卷、通灵可选池，不进行随机抽池。
- 忍者池双方共用：已禁或已被任一方选中的忍者不能再选。
- 每方每局选 3 名忍者、3 个秘卷、3 个通灵。
- 秘卷和通灵为各自独立池：双方可以选择同一个项目，但同一玩家不能重复选择。
- BO3 内，前一小局已经被选择的忍者不能再用；同一玩家前一小局选择过的秘卷和通灵也不能再用。
- 默认开启“小局 Ban”：每局走 4 手禁用。关闭后，只有首局禁用，后续局继承首局禁用名单。
- 在线房间只有两个席位：1P 创建房间并担任房主，负责开始、记录胜者、开启下一局和在 BO3 结束后的准备阶段交换 1P/2P 席位；2P 只能操作自己的回合。

## 本地运行

```bash
npm install
npm run dev
```

访问终端输出的地址。手机与电脑处在同一局域网时，使用电脑的局域网 IP 加端口访问。

## 生产部署

当前生产站点使用 Pages 提供页面和同源 WebSocket 入口，现有 Worker 的 Durable Objects 持久保存房间。更新页面或数据包后运行：

```bash
npm run deploy:pages
```

修改房间 Worker 或共用 BP 规则时，先运行 `npm run deploy` 更新 Worker，再运行 `npm run deploy:pages` 更新页面和入口。房间无活动 6 小时后过期。

以下 Node 服务命令用于本地或自行管理的备用主机：

```bash
npm install
npm run build
npm run server
```

在线页面刷新、手机锁屏或短时断网后会自动重连并恢复原席位。Node 备用服务的房间保存在内存中，服务重启会清空未完成房间。

Railway/Node 是[备用部署方案](docs/公网部署.md)。`server/index.ts` 的房间保存在内存中，只建议用于本地开发或自行管理的 Node 主机。

## 数据包格式

主界面的“导入数据包”接受 JSON，格式：

```json
{
  "id": "2026-q3-community",
  "name": "2026 Q3 社区维护池",
  "updatedAt": "2026-08-25",
  "ninjas": [{ "id": "ninja-001", "name": "示例忍者", "rank": "S", "tags": ["近战"] }],
  "scrolls": [{ "id": "scroll-001", "name": "示例秘卷", "tags": ["控制"] }],
  "summons": [{ "id": "summon-001", "name": "示例通灵", "tags": ["先手"] }]
}
```

完整 BO3 数据包至少包含 22 名忍者、9 个秘卷和 9 个通灵：18 个不同忍者用于三局选择，另保留至少 4 个禁用位。每个条目可使用 `image` 字段指定本地 `/assets/` 路径或 HTTPS 图片地址。官网汇总包和演示包分别标注；当前没有经赛事名单核验的比赛包。
