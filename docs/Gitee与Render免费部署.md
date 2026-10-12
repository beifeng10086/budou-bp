# Gitee 与 Render 免费部署

GitHub 授权不稳定时，可以尝试把本项目放入 Gitee 公开仓库，再让 Render 从公开 Git 地址拉取代码。Render 支持公开 Git 仓库地址，但能否从其构建服务器拉取具体 Gitee 仓库，需要以首次部署结果为准。

公开仓库会展示项目源码、内置资料包和图片。本方案不包含个人登录信息、浏览器资料、依赖目录或本地缓存；这些内容由 `.gitignore` 排除。

## 创建与上传仓库

1. 在 https://gitee.com/login 登录或注册 Gitee。
2. 在 https://gitee.com/projects/new 创建公开仓库，建议名称 `budou-bp`。
3. 不勾选初始化 README、`.gitignore` 或许可证，保持仓库为空。
4. 使用 Git 将当前项目推送到该仓库。实际远程地址由新仓库页面提供，不要直接使用下面的占位地址。

```powershell
Set-Location 'C:\Users\29851\Documents\ChatGPT\武斗bp'
git remote add origin https://gitee.com/你的用户名/budou-bp.git
git push -u origin master
```

如果 HTTPS 上传需要登录信息，请在 Git 的本地登录窗口或提示中自行输入。也可以配置 SSH 公钥后改用仓库页面提供的 SSH 地址；私钥只保存在本机。

仓库需要允许未登录用户拉取。若 Gitee 提示公开审核，等审核完成后再部署。

## 创建免费网页服务

1. 登录 https://dashboard.render.com/ 。可以使用邮箱注册，不必依赖 GitHub 登录。
2. 选择 **New > Web Service > Public Git Repository**。
3. 填入实际 Gitee 仓库的 HTTPS 地址，然后点击 **Connect**。
4. 使用以下配置。此入口按表格配置服务，不依赖自动识别 `render.yaml`。

| 配置 | 值 |
| --- | --- |
| Name | `budou-bp`，若重名则使用可用名称 |
| Region | Singapore |
| Branch | `master` |
| Runtime / Language | Node |
| Root Directory | 留空 |
| Build Command | `npm ci && npm run build` |
| Start Command | `npm run server` |
| Instance Type | Free |
| Health Check Path | `/health` |
| Environment Variable | `NODE_VERSION=22.16.0` |

5. 确认实例类型为 **Free** 后创建服务。无需添加数据库或磁盘。
6. 等待构建和启动成功，使用控制台显示的实际 `https://...onrender.com` 地址。仓库网址不能作为 BP 网页网址。

如果构建日志显示 Git 拉取失败，需排查仓库公开状态及 Render 到 Gitee 的连接；这时网页尚未发布。

## 验证与维护

- 访问实际公网地址的 `/health`，确认返回 `ok: true`。
- 确认网页、资料包和图片加载成功。
- 用两个独立浏览器创建、加入同一房间，验证席位、BP 同步和刷新恢复。
- 用手机流量、Wi-Fi 及微信浏览器检查实际访问情况。
- 公开 Git 地址方式不提供自动部署。更新时先推送到 Gitee，再在 Render 服务页面选择 **Manual Deploy > Deploy latest commit**；服务网址保持不变。

免费服务空闲后会休眠，首次访问可能需要约一分钟唤醒。房间保存在内存中，服务休眠、重启或部署后会丢失；应避开正在进行的比赛时段更新。在线房间的心跳会发送 WebSocket 消息，但用户关闭网页、浏览器挂起或网络断开后，不应依赖心跳保持服务运行。

免费额度和网络可达性以平台当前说明及实际测试为准。

参考： https://render.com/docs/web-services
