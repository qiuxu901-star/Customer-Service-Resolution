# Customer Service Resolution · 客服 AI 解决能力价值评估平台

度量「客服-司机会话中，我方 AI 能力实际解决了多少问题」的内部工具：**和评估助手对话获取数据与分析结论 → 输入会话检测 → 信息不足时提问 → 结果落入人工复核平台 → 全盘记录 + 数据看板 → 材料就绪度追踪 → 同口径复验**。

> 内部业务工具，保留所有权利；仅限公司内网使用，未内置登录鉴权，请勿部署到公网。

## 目录结构

```
├── solve-eval-app/          # 应用本体（Node 原生 http，零外部依赖）
│   ├── server.js            # http 服务 + 路由 + 统计 + Agent 端点 + 模板/导入/版本管理
│   ├── engine.js            # 检测引擎（规则/LLM 双模式，规则清单十二段）
│   ├── agent.js             # 评估助手（规则路由 + LLM 工具调用 + 材料就绪度 + 结论生成）
│   ├── materials.js         # 材料数据集与版本管理（9 类资料库：版本提交/快照/回滚/导入）
│   ├── storage.js           # JSON 文件存储层
│   ├── standards-seed.js    # 种子标准库（示例尺子）
│   ├── public/              # 单页应用（10 视图）
│   └── README.md            # 应用详细文档（功能地图 / 纪律 / 启动）
├── 客服AI解决能力价值评估-业务需求及评估标准-V2.1.md   # 业务基线
├── 客服AI解决能力价值评估-产品需求文档PRD-V1.0.md      # 产品功能需求
├── 客服AI解决能力价值评估-检测规则清单-V1.0.md        # 引擎执行规则
├── Agent对接与数据获取说明.md                        # Agent 三种形态与 API 契约
├── 材料提供清单与导入指引.md                          # 11 类材料与最小启动集
├── templates/               # 10 个导入模板 CSV（与应用内下载一致）
├── CHANGELOG.md             # 版本变更记录
└── .github/workflows/ci.yml # CI：语法检查 + 启动冒烟
```

`N检测业务需求与评估标准_V1.1.md` 为 V2.1 之前的基线，仅作历史存档。

## 快速开始

```bash
cd solve-eval-app
node server.js          # Node >= 18，零依赖，无需 npm install
# 本机打开 http://localhost:8817
```

- 默认进入「评估助手」视图，直接对话提问即可取数
- 服务默认绑定 `0.0.0.0`，启动日志打印局域网地址，同局域网同事可直接共同访问（详见 `solve-eval-app/README.md`「局域网共同访问」章节）
- 数据落在 `solve-eval-app/data/db.json`（已被 .gitignore 排除，不会入库）
- 切换大模型模式：应用内「设置」页填入 OpenAI 兼容接口

## 版本迭代管理约定

| 项 | 约定 |
|---|---|
| 版本号 | 语义化版本：功能迭代升 minor（v1.1.0），缺陷修复升 patch（v1.0.1），不兼容变更升 major |
| 封版 | 每次封版打附注 tag（`git tag -a v1.x.0 -m "说明"`），并更新 `CHANGELOG.md` |
| 分支 | `main` 为唯一稳定分支；新功能开 `feature/*`，紧急修复开 `hotfix/*`，完成后 PR 合入 main |
| CI | push/PR 到 main 自动跑：JS 语法检查 + 服务启动冒烟（bootstrap 与 agent/chat 健康检查） |
| 发布 | GitHub Release 对应每个 minor/major tag，发布说明摘自 CHANGELOG |

当前版本：**v1.1.0**（2026-10-15 材料中心版本管理 + 助手配置维护 + 意图库整树导入，见 CHANGELOG）。

## 线上部署（2026-10-14）

| 项 | 值 |
|---|---|
| 服务器 | 阿里云 ECS `47.103.25.159`（CentOS 8，root + SSH 密钥认证） |
| 应用目录 | `/opt/customer-service-resolution` |
| 服务单元 | systemd `csr`（`Restart=always`，开机自启，独立日志 `server.log`） |
| 端口 | `8818`（与应用内默认 8817 区分，专供线上） |
| 访问路径 A | `http://47.103.25.159:8818`（需在阿里云安全组放行 8818/tcp 入方向） |
| 访问路径 B | `http://csr.2566.online`（nginx 反代 `zz-csr.conf` → 127.0.0.1:8818，需 DNS 加 A 记录；80/443 已在安全组放行） |
| HTTPS | DNS 生效后执行 `certbot --nginx -d csr.2566.online`（服务器已装 certbot） |
| 隔离性 | 独立目录 / 独立端口 / 独立 systemd 单元 / 独立 nginx conf（`zz-` 前缀保证加载顺序在原有配置之后，不抢占默认服务器位），与 iter-board、weekly-board、time-harness 互不影响 |
| 数据 | 服务器为全新空库，`data/db.json` 在 `/opt/customer-service-resolution/solve-eval-app/data/` |

**版本更新到服务器**（数据目录自动保留，不丢记录）：

```bash
# 本机：封版打 tag 后构建发布包
git archive <tag> | tar -x -C /tmp/csr-pkg/customer-service-resolution
tar -czf /tmp/csr-pkg/csr-<tag>.tar.gz -C /tmp/csr-pkg customer-service-resolution
scp /tmp/csr-pkg/csr-<tag>.tar.gz root@47.103.25.159:/tmp/

# 服务器：一键部署/更新
ssh root@47.103.25.159
cd /tmp && tar -xzf csr-<tag>.tar.gz customer-service-resolution/scripts/deploy.sh
bash customer-service-resolution/scripts/deploy.sh /tmp/csr-<tag>.tar.gz
# 如需换端口：PORT=8819 bash customer-service-resolution/scripts/deploy.sh /tmp/csr-<tag>.tar.gz
```

> 注意：阿里云安全组在云控制台配置，脚本无法代改；防火墙（firewalld/ufw）服务器端未启用。
