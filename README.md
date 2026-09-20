# WorkBuddy × DeepSeek Harness 反代实现分析

把 **WorkBuddy 桌面 App** 里包含的模型（GLM-5.3、GLM-5.2、DeepSeek-V4-Pro、DeepSeek-V4-Flash、Kimi-K3、MiniMax-M3、Hy3 等）自动接入 **DeepSeek Harness（DSH）**，在 DSH 对话窗口里零配置直接使用；外加对四个相关仓库的完整整合分析与实施方案。

本仓库 = **一个可用的 DSH 插件（真实开发代码）** + **一套分析/交接文档**。

---

## ⚠️ 安全说明（先读这一段）

**本仓库不含任何凭据、密钥或账号配置。** 具体地：

- 登录信息**由你本机的 WorkBuddy 桌面 App 提供**，插件**只读不写、不外传**。插件不含、也不会携带任何 token。
- 未收录任何 `access_token` / `refresh_token` / `.env` / `*.key` / `*.pem` / 账号配置文件。
- 未收录本机路径信息（作者本机的 `~/.dsh` 目录内容一律未入库）。
- 仓库内的 `refresh_token`、`access_token` **字样**仅出现在协议实现代码与文档说明中，均为**字段名**，无对应真实值。
- 第三方上游仓库（见下文）未收录，避免版权与体积问题。

> 本仓库是**公开**的。任何人在 clone 后使用前，请自行确认自己的使用方式符合 WorkBuddy 服务条款。

---

## 这是什么项目

`1-dsh-workbuddy-connect` 是一个 **DSH 插件**：它读取本机 WorkBuddy 桌面 App 的登录态，向上游请求模型目录与账号信息，并把这些模型注册成 DSH 的一个 provider（`provider: workbuddy`），从而在 DSH 的模型选择器里直接选用。

国内版 **WorkBuddy** 与国际版 **WorkBuddy AI** 同时支持：装哪个 App 就出现哪个模型分组，两个都装则两组并存，各自用自己的账号与积分、互不混用。

本目录同时包含一份**四仓库整合分析**：把 `2/3/4` 两个「控制台」项目里值得保留的展示类能力，合并进这个插件，做成 DSH 设置里的一个独立 WorkBuddy 功能板块。

---

## 选择模型（P1.5，已实现）

插件默认会把上游目录里的**全部模型**注册给 DSH。如果你不希望模型选择器里出现几十个条目，可以在插件卡片里逐项勾选：

**设置 → 插件 → DSH WorkBuddy Connect → 模型选择**（国际版同理，各管各的）。

只有被选中的模型会出现在 DSH 的模型选择器里。三条关键语义：

| 行为 | 结果 |
|---|---|
| **从未配置** | 展示全部模型（保证升级后选择器不会突然变空） |
| **显式全不选** | 一个都不显示（与「从未配置」是两回事） |
| **「显示全部」** | 清除选择记录，回到「从未配置」状态 |

**被隐藏的模型仍然可用**：过滤只影响模型选择器里显示什么，不影响路由。已经保存的会话或默认模型即使指向你后来取消勾选的模型，依旧可以正常解析和调用——不会因为改了一次选择就把旧对话弄坏。

**已选模型被上游下线时**，选择记录会保留并在面板上明确提示（而不是静默丢弃你的配置），若日后恢复即自动重新生效。

> 该功能的实现细节与取舍见提交 `346f2ad`；对应的端到端用例在
> `1-dsh-workbuddy-connect/tests/model-selection*.spec.ts`。

---

## 快速开始（新设备）

### 0. 关键前提

**必须先在本机安装并登录 WorkBuddy 桌面 App。**

插件**只读**它的登录态来获取模型列表与积分信息；它**不携带任何凭据**，也没有自己的账号体系。没装/没登录 App 时，对应的模型分组不会出现。

- 国内版：WorkBuddy 桌面 App
- 国际版：WorkBuddy AI 桌面 App（自插件 v0.5.0 起支持）
- 两版可同时安装，互不影响

### 1. 环境要求

| 项 | 要求 |
|---|---|
| **Node.js** | `^22.19.0 \|\| >=24.0.0`（见 `1-dsh-workbuddy-connect/package.json` 的 `engines`） |
| **pnpm** | 必需。**只能用 `--frozen-lockfile`** 安装 |
| DSH 核心 | `0.1.5-rc.1` 及以上（插件与 DSH 核心版本一一对应，不匹配会导致 DSH 启动失败） |
| OS | Windows / macOS / Linux（WSL 支持，见「已知限制」） |

> ⚠️ **务必使用 `pnpm install --frozen-lockfile`**。`@deepseek-ai/*` 的 npm `latest` dist-tag 指向旧的 `0.0.1-rc.x`，直接 `npm install` 会装错版本。

### 2. 克隆与构建

```bash
git clone https://github.com/dhllovew/workbuddy-dsh-integration.git
cd workbuddy-dsh-integration/1-dsh-workbuddy-connect

pnpm install --frozen-lockfile
pnpm run check          # = typecheck && test && build（完整质量门）
```

`pnpm run check` 会依次执行：

```bash
npx tsc -p tsconfig.json          # host 半：只查 src（排除 src/client）+ 大部分 tests
npx tsc -p tsconfig.client.json   # 浏览器半：src/client + 5 个 client 测试
npx vitest run                    # 全部单测
npx tsdown                        # 构建，输出 lib/
```

**预期结果**：363 个用例，**361 通过 / 2 失败**。两个失败**均为平台条件问题，非回归**，详见「已知限制」。

### 3. 装进 DSH profile

```bash
# 本地目录 -> link: 安装（开发用）
dsh plugin --profile web add /path/to/workbuddy-dsh-integration/1-dsh-workbuddy-connect

# 启动 Web（注意：--profile 不能叠在 web 子命令后面）
dsh --profile web --no-open --port 3099
```

启动后日志会打印带 token 的访问地址（形如 `http://127.0.0.1:3099/?token=XXXX`），用它打开页面。

安装后在**模型选择器**里切换到 WorkBuddy 模型即可使用；在 **设置 → 插件** 里可看到插件卡片，查看账号、令牌有效期、剩余积分与模型列表来源。

---

## 目录结构

```
workbuddy-dsh-integration/
├── README.md                          # 本文件
├── .gitignore                         # 排除凭据 / node_modules / 第三方克隆
│
├── 1-dsh-workbuddy-connect/           # ★ 核心：DSH 插件（TypeScript）
│   ├── src/                           #   源码（host 半 + React 浏览器半）
│   │   ├── index.ts                   #     插件入口
│   │   ├── upstream.ts                #     上游协议实现（P0 协议对齐的成果）
│   │   ├── catalog.ts                 #     模型目录 + 选择过滤（可见性 vs 可解析性）
│   │   ├── auth.ts                    #     读取本机 App 登录态（只读）
│   │   ├── shim.ts                    #     同源路由 + loopback 守卫
│   │   ├── client/                    #     浏览器半（React 视图 + 槽位注册）
│   │   └── ...
│   ├── tests/                         #   vitest 用例（含选择模型的端到端覆盖）
│   ├── lib/                           #   构建产物（tsdown 输出）
│   ├── scripts/                       #   实测/校验脚本
│   ├── assets/                        #   README 配图
│   ├── docs/                          #   补充技术文档
│   ├── cordis.patch.yml               #   DSH bundle 补丁
│   └── package.json                   #   engines: node ^22.19.0 || >=24.0.0
│
├── 00-总览与整合方案.md                # 完整分析报告（槽位证据 / 能力判定矩阵 / 路线）
├── 01-开发交接文档.md                  # 执行向交接文档（状态快照 / 踩坑记录 / 待办）
├── 02-WorkBuddy板块功能预期Demo.html   # 板块功能预期 Demo（可直接浏览器打开）
│
└── .probe/                            # 本地调试脚本与 UI 验证截图
    ├── boot-web.ps1 / boot-web-real.ps1 / kill-port.ps1
    ├── find-section-slot.mjs / dump-section-contract.mjs
    ├── eol.mjs                        # 查文件行尾（CRLF/LF）
    └── ui-01-loaded.png ... ui-03-plugins.png   # 已验证的 UI 截图证据
```

---

## 文档索引

| 文档 | 内容 |
|---|---|
| [`00-总览与整合方案.md`](./00-总览与整合方案.md) | **完整分析报告**。槽位证据（§2.2.1–2.2.3）、硬约束（§2.3）、能力判定矩阵（§3.3）、路线 A/B（§4）、阶段表（§5）、P0 实施记录（§5.1）、风险红线（§6） |
| [`01-开发交接文档.md`](./01-开发交接文档.md) | **执行向摘要**。面向零上下文的接手者：任务定义、当前状态、开发环境与踩坑、P0 成果、关键技术事实、P1–P6 待办、已知问题 |
| [`02-WorkBuddy板块功能预期Demo.html`](./02-WorkBuddy板块功能预期Demo.html) | 板块功能的交互 Demo，直接用浏览器打开即可查看预期效果 |
| [`1-dsh-workbuddy-connect/README.md`](./1-dsh-workbuddy-connect/README.md) | 插件自身的用户文档（功能、安装、命令行、免责声明） |

---

## 关于第三方项目（2/3/4）

本仓库**不包含**以下三个第三方开源项目。它们各自有独立的上游仓库，代码版权归各自作者所有，且体积较大（含 `node_modules`）。**本仓库未包含、也未修改它们的任何代码。**

| 目录 | 上游项目 | 技术栈 | 在本分析中的角色 |
|---|---|---|---|
| `2-workbuddy2api` | [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) | Go | **协议权威** —— 上游线格式的事实源 + OpenAI 兼容账号池网关 |
| `3-workbuddy2api-gui` | [linbeize/workbuddy2api-gui](https://github.com/linbeize/workbuddy2api-gui) | Go + React/Vite | `[2]` 的控制台 |
| `4-workbuddy-manager` | [ithtelab/workbuddy-manager](https://github.com/ithtelab/workbuddy-manager) | FastAPI + Next.js | `[2]` 的运营控制台 |

**如需阅读分析中引用的上游源码，请自行克隆：**

```bash
git clone https://github.com/Sliverkiss/workbuddy2api.git 2-workbuddy2api
git clone https://github.com/linbeize/workbuddy2api-gui.git 3-workbuddy2api-gui
git clone https://github.com/ithtelab/workbuddy-manager.git 4-workbuddy-manager
```

> 本仓库的 `.gitignore` 已将这三个目录排除，因此即使你在本地克隆，也不会被误提交。

### 为什么不作为 submodule（方案对比）

| 方案 | 说明 | 结论 |
|---|---|---|
| **A. 不纳入，README 给出上游地址** | 使用者按需自行 clone | ✅ **本仓库采用**。简单可靠，不引入 submodule 的递归克隆负担，也不会因上游 force push 而损坏引用 |
| B. 作为 git submodule | 引用固定 commit | ❌ 未采用。分析工作只需读取上游源码，submodule 会增加 clone 复杂度且无实际收益 |

**免责说明**：上述项目及相关分析**仅供个人学习研究使用**。请遵守各自的开源许可证与服务条款。本仓库与腾讯、WorkBuddy、DeepSeek 及上述项目的作者均无关联，未获其授权或认可。

---

## 已知限制

以下问题**已知且非本仓库引入的回归**，记录在此以免后来者误判：

1. **`processStartTimeMs` 在现行 Windows 上恒失效（真实缺陷，未修）**
   `src/host-heartbeat.ts` 的 win32 分支调用 `wmic`，而 `wmic` 自 Windows 11 24H2 起已被移除。
   后果：该函数恒返回 `undefined`，「PID 被复用」检测**实际不生效**，退化为纯 PID 存活判断。
   影响：`tests/host-heartbeat.spec.ts` →「detects a recycled PID as dead」在本机失败。
   修法：改用 `powershell -c "(Get-CimInstance Win32_Process -Filter 'ProcessId=<pid>').CreationDate"`。

2. **WSL 路径用例在 Windows 宿主上恒失败（测试夹具平台依赖）**
   `tests/auth.spec.ts` →「uses translated WSL environment paths when the Windows user differs」。
   Windows 宿主上 `tmpdir()` 带盘符（如 `D:\`），WSL 翻译**正确**产出 `/mnt/d/...`，但断言用宿主 `join` 拼出反斜杠路径。该用例需要 POSIX 的 `tmpdir()` 才能通过。

3. **单元测试无法覆盖真实槽位 API**
   client 半边 import 的是浏览器专用包，Node 测试环境加载不了；`tests/client-fallback.spec.ts` 只是**镜像**了 `apply()` 的形状。因此**真实 UI 走查不可省**（见 `01-开发交接文档.md` §3.3）。

4. **依赖 WorkBuddy 的非公开客户端接口**
   WorkBuddy 更新后插件可能需要随之调整。国际版模型目录来自 App 界面接口，服务端按 User-Agent 分流下发，属私有实现，上游改动可能使其失效（届时按「上次成功目录 → 内置目录」降级并在卡片标明来源）。

---

## 工程约定（改代码前必读）

1. **仓库是 CRLF 行尾**（`src/**`、`tests/**` 均为 CRLF，而 `*.md` 是 LF）。用编辑器替换文本时 `old_string`/`new_string` **必须带 `\r\n`**，否则「找不到匹配」且原因极难猜。`.probe/eol.mjs` 可查某文件行尾。
2. **两套 tsconfig 分区检查**：新增 **client 侧测试文件必须加进 `tsconfig.client.json` 的 `include`**，且**不要**加进 `tsconfig.json`（后者显式 `exclude` 了 `src/client` 与那 5 个 client 测试）。
3. **`apply()` 的 try/catch 形状在 `tests/client-fallback.spec.ts` 里被镜像复制**。改了 `src/client/index.tsx` 的 guarded body 或 `console.error` 文案，**必须同步改那个 spec**。
4. **`settings.section` 的注册项形状是 `{ name, id, order, label, locale, inject, children? }`**，与 `settings.plugin.item` 用的 `key`/`priority` **不同名**，不能照搬。
5. 只能 `pnpm install --frozen-lockfile`（见「环境要求」）。

---

## 文档中提到的一些环境处理坑（Windows）

- **Cmd 会破坏带引号的路径**：`dir "C:\Program Files\x"` 报「文件名、目录名或卷标语法不正确」。改用 8.3 短路径或改用编辑器的文件工具。
- **Windows PowerShell 5.1 按 ANSI 解码 `.ps1`**：脚本里的中文路径会变乱码。对策：脚本正文只用 ASCII。
- **脱离式启动长驻进程**用 `Start-Process -FilePath cmd.exe -WindowStyle Hidden -ArgumentList '/c', '<命令>'`；直接 `start` 起的进程会随工具调用超时一起被杀。

---

## 许可证

本仓库中**原创部分**（插件代码与分析文档）采用 [MIT](./1-dsh-workbuddy-connect/LICENSE)。
第三方项目版权归各自作者所有，未包含在本仓库中。

---

## 免责声明

- 本项目**仅供个人学习和研究使用**，仅驱动使用者自己的 WorkBuddy 账号在本机调用。请勿用于商业用途或超出个人合理使用的场景。
- 使用者需遵守 WorkBuddy 的服务条款。因使用本项目产生的任何后果（包括但不限于账号被限制、额度被清空、服务中断），由使用者自行承担。
- 本项目作者不对任何因使用或滥用本项目产生的直接或间接损失负责。
- 本项目与腾讯、WorkBuddy、DeepSeek 均无关联，未获其授权或认可；文中出现的名称仅用于描述兼容关系，其商标权利归各自所有。
