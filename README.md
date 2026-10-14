# Customer Service Resolution · 客服 AI 解决能力价值评估平台

度量「客服-司机会话中，我方 AI 能力实际解决了多少问题」的内部工具：**和评估助手对话获取数据与分析结论 → 输入会话检测 → 信息不足时提问 → 结果落入人工复核平台 → 全盘记录 + 数据看板 → 材料就绪度追踪 → 同口径复验**。

> 内部业务工具，保留所有权利；仅限公司内网使用，未内置登录鉴权，请勿部署到公网。

## 目录结构

```
├── solve-eval-app/          # 应用本体（Node 原生 http，零外部依赖）
│   ├── server.js            # http 服务 + 路由 + 统计 + Agent 端点 + 模板/导入/复验
│   ├── engine.js            # 检测引擎（规则/LLM 双模式，规则清单十二段）
│   ├── agent.js             # 评估助手（规则路由 + LLM 工具调用 + 材料就绪度 + 结论生成）
│   ├── storage.js           # JSON 文件存储层
│   ├── standards-seed.js    # 种子标准库（示例尺子）
│   ├── public/              # 单页应用（9 视图）
│   └── README.md            # 应用详细文档（功能地图 / 纪律 / 启动）
├── 客服AI解决能力价值评估-业务需求及评估标准-V2.1.md   # 业务基线
├── 客服AI解决能力价值评估-产品需求文档PRD-V1.0.md      # 产品功能需求
├── 客服AI解决能力价值评估-检测规则清单-V1.0.md        # 引擎执行规则
├── Agent对接与数据获取说明.md                        # Agent 三种形态与 API 契约
├── 材料提供清单与导入指引.md                          # 9 类材料与最小启动集
├── templates/               # 7 个导入模板 CSV（与应用内下载一致）
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

当前版本：**v1.0.0**（2026-10-14 首个可运行封版，见 CHANGELOG）。
