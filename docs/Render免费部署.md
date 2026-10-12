# Render 免费部署与维护

项目已上传 Gitee，但 2026-10-13 实测 Render 的仓库表单拒绝 Gitee 地址。需要将代码镜像到 GitHub、GitLab 或 Bitbucket 后再部署；详见 [Gitee 与 Render 部署实测](./Gitee与Render免费部署.md)。公开 Git 地址入口的后续更新需要手动触发。

Cloudflare `workers.dev` 在当前电脑和手机移动网络均无法访问，因此备用公网方案改为 Render Free Web Service。Render 的 `onrender.com` 应用域名已在当前电脑实测可达，服务支持 HTTPS 和 WebSocket，可以直接运行本项目现有的 Node 房间服务。

## 免费层限制

- 每个工作区每月提供 750 个免费实例小时，足够单个服务整月运行；额度和规则以 Render 控制台实时显示为准。
- 服务连续 15 分钟没有 HTTP 请求或 WebSocket 消息后会休眠。下一次访问会自动唤醒，通常需要几十秒，Render 文档提示可能约 1 分钟。
- 网页在线房间每 25 秒发送一次轻量心跳；只要任一玩家仍连接，进行中的 BP 不会因“无流量”而休眠。
- 免费实例没有持久磁盘。正在进行的房间保存在内存中，服务重启、重新部署或休眠后会消失；资料包和图片包含在部署文件中，不受影响。
- Render 免费服务适合当前测试和社区小规模使用。若后续玩家量明显增长或要求不休眠、房间永久恢复，需要迁移到带持久数据库的方案。

## 项目已经准备好的内容

- `render.yaml`：新加坡区域、Node 22、免费套餐、构建和健康检查配置。
- `server/index.ts`：支持两个席位、令牌恢复、服务端权限和选池校验、服务端计时、无活动 6 小时后清理房间。
- 前端每 25 秒发送心跳，刷新或短时断线后自动重连并恢复原席位。
- `/health` 返回服务状态；前端、头像、资料包和 `/ws` 使用同一个 HTTPS 域名。

## 首次发布

Render 需要从 Git 仓库拉取项目。当前目录已经初始化并提交了可部署代码，但尚无 GitHub 远端；当前电脑连接 GitHub 登录页面超时，因此还没有创建仓库。网络恢复后，请先在 GitHub 新建空仓库，把本地提交推送过去，然后打开：

```powershell
Set-Location 'C:\Users\29851\Documents\ChatGPT\武斗bp'
git remote add origin https://github.com/你的用户名/你的新仓库名.git
git push -u origin master
```

不要在 GitHub 新仓库里预先创建 README、`.gitignore` 或 License，以免首次推送需要处理冲突。建议先设为 private；部署时在 Render 授权读取该仓库。若使用 public 仓库，请先考虑头像、图标的素材分发授权。

连接仓库之后打开：

https://dashboard.render.com/blueprints

选择 **New Blueprint Instance**，连接该 GitHub 仓库。Render 会读取根目录的 `render.yaml`，创建名为 `budou-bp` 的免费 Web Service。确认页面显示 `plan: free` 后执行部署，不需要添加数据库、磁盘或付费实例。

部署完成后会得到类似下面的固定网址：

```text
https://budou-bp.onrender.com
```

若名称已被占用，Render 会使用另一个可用子域名，以控制台实际地址为准。

## 上线检查

1. 首次打开可能处于唤醒阶段，等待页面加载完成。
2. 打开 `https://实际地址/health`，应返回 `{"ok":true,"service":"budou-bp-node",...}`。
3. 手机 A 创建房间，把邀请链接发给手机 B；B 应成为 2P。
4. A 刷新后仍应恢复 1P；第三个浏览器应被拒绝。
5. 完成禁用、忍者、秘卷、通灵和结果图保存流程。
6. 分别用移动数据、Wi-Fi 和微信内置浏览器验证。

## 后续更新

把新提交推送到同一 GitHub 仓库，Render 会自动构建并更新同一网址。部署会重启免费实例，因此应避开正在进行的比赛时段。

Cloudflare Worker 版本暂时保留作为代码备份，但 `workers.dev` 地址不再作为面向玩家的入口。
