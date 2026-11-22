# dsh-island-go · 灵动岛（DSH Go 版）

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的「灵动岛」在 **DSH Go**（Android App）里的原生形态。

> **本机修复版 0.1.2**（2026-11-22）。修了三件事：
> 1. **模型识别不出来**：0.1.0 只从 `model/selection` / `assistant/attempt` 取模型名，但这两类事件在当前 Harness 里不带模型，面板就一直是「未知模型」。改成从 `assistant/message` 的 `message.source.model` 取（每次调用自己的模型），`request/header` 的 `header.config.model` 兜底。
> 2. **费用一直是 ¥0.00**：模型为空 → 官方没有对应单价 → 估不出钱。模型能认出来以后按官方价正常估算；另外还有没定价的调用时不再写成 `¥0.00`，而是 `—` / `≈¥…`。
> 3. **历史账本不会自愈**：旧账本 `usage.json` 记的是空模型、0 费用。现在账本带版本号（2），加载时发现旧版本会自动重新扫描会话日志补算；连日志都被删掉的会话，用当前默认模型补一个「约」价（`≈`）。
>
> 另外按官方口径把中国法定节假日算进空闲时段（原版只按周一至周五判断），并把面板里「近 7 天」和「今日」两组数字分开标注。
>
> **0.1.2 起，费用不再只认 DeepSeek 官方两个模型**：见下面「计费范围」。

桌面版 [`dsh-island`](https://github.com/a961282799-crypto/dsh-island) 靠 Electron 画一个置顶悬浮窗；App 里不能开跨应用悬浮窗，所以这个包不画窗口，只把同一份引擎侧数据接到 App 的原生插槽上：

| 插槽 | 位置 | 显示什么 |
| --- | --- | --- |
| `composer.strip` 状态条 | 输入框上方一行（≤ 24 字） | `思考中 · 上下文 38% · ¥0.42`；空闲时 `空闲 · 今日 ¥1.20` |
| `panels` 面板 | 对话详情 › 插件页签、全部功能 | 状态、上下文占用进度、近 7 天 tokens 柱状图、今日 tokens / 输出 / 缓存命中 / 轮次、按模型的 tokens 与费用 |
| `turn.note` 尾注 | 每轮脚注末尾 | 这一轮的估算费用，如 `¥0.02` |

面板里的「复制摘要」把同一份数字写成几行文字放进剪贴板。

## 和桌面版的关系

两个包完全独立，可以同时安装：

|  | `dsh-island`（桌面版） | `dsh-island-go`（本包） |
| --- | --- | --- |
| 平台 | Windows 桌面 + Electron 运行时 | DSH Go App（本机引擎） |
| 形态 | 置顶悬浮窗、托盘、动效 | 状态条 + 面板 + 尾注 |
| 审批 / 提问 / 停止 / 发消息 | 支持 | 不提供（App 不允许插件代答审批或改会话语义） |
| 依赖 | 需要 Electron | 零依赖、不需要构建 |

同一个包名、同一个 plugin id 只有一份配置，装哪个生效哪个；两者共用 `state.js` / `usage.js` / `pricing.js` 三块引擎侧逻辑。

## 安装

在 App 的「终端」（本机环境 shell）里：

```sh
dsh plugin --profile web add dsh-island-go
```

或在 DSH Go 的 `设置 › 插件 › 插件市场` 里搜「灵动岛」。装上即生效，不用重启（App 会重新拉一次清单）。

远程主机（SSH / 中转）没有 dsh-go 桥接：那里只累积账本，状态条与面板不会出现。

## 数据与隐私

- 只读引擎自己的会话事件：状态、计划进度、上下文窗口与 token 数、模型名。
- 账本存在 `$DSH_HOME/dsh-island-go/usage.json`（默认 `~/.dsh/dsh-island-go/usage.json`），只记轮次、模型、时间、tokens 与估算费用，保留 35 天，**不含对话正文**。
- 不读密钥、不发网络请求、不新增监听端口。
- 高峰时段＝北京时间周一至周五（不含法定节假日）9:00–12:00、14:00–18:00，其余时段为空闲时段（半价）；节假日表取自国务院办公厅 2026 年放假通知。
- 费用按 [DeepSeek 官方价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)（2026-11-22 核对）逐次调用估算，仅供参考，以账单为准。

## 计费范围

| 模型 | 单价来源 |
| --- | --- |
| `deepseek-flash`、`deepseek-v4-pro`（及旧名 `deepseek-v4-flash`） | 内置的 DeepSeek 官方价，分高峰 / 空闲时段 |
| 其他模型（MIMO、KIMI、MiniMax、GLM、Qwen 等自定义渠道） | 运行时读引擎自带的模型库（`@earendil-works/pi-ai` 的 provider 数据），按 `美元 / 百万 tokens × 7.2` 折成人民币；同一模型在多份目录里报价不同时优先取官方直连那份，订阅制渠道写的 0 价不算「免费」，会被跳过 |
| 上面都没有 | 显示「未定价」，只统计 tokens，不算钱 |

模型库读不到（换了引擎版本、目录结构变了）时只会退化成「未定价」，不影响其他功能。

想自己定价就写 `$DSH_HOME/dsh-island-go/prices.json`，单位是**人民币 / 百万 tokens**，优先级最高：

```json
{
  "models": {
    "glm-5.3-flashx": { "input": 1, "output": 3.5, "cacheRead": 0.2 },
    "my-model": {
      "peak": { "input": 2, "output": 8, "cacheRead": 0.04 },
      "offPeak": { "input": 1, "output": 4, "cacheRead": 0.02 }
    }
  }
}
```

- 只写 `input` / `output` / `cacheRead` 表示全天同价；写了 `peak` / `offPeak` 才分时段。
- `cacheWrite` 不写就按「缓存未命中」价算（DeepSeek 就是这种口径）。
- 改完重启引擎生效；重启时会把之前「未定价」的轮次按新价格补算一遍。

## 兼容性

按 DSH Go 1.1.0 的原生插件协议（`package.json` 的 `dshGo` v1、`ctx.dshGo`、视图组件目录）与内置引擎 `r15-dsh0.2.2-rc.1` 的文档实现，`engines.dsh` 声明为 `>=0.2.2-rc.1 <0.3.0-0`。

**尚未在真机上跑过**：状态条、面板、尾注三处的数据链路由单测覆盖（视图尺寸、绑定、清单一致性），但 App 端的实际渲染与桥接握手需要在装了桥接的主机上验证。发现问题请到 [issues](https://github.com/a961282799-crypto/dsh-island-go/issues)。

## 开发

```sh
node test/apply.test.mjs     # 假宿主：注册、事件、三条插槽的数据
node test/view.test.mjs      # 视图/数据/状态条/尾注的形状与上限
node test/ledger.test.mjs    # 一轮事件折成带费用的记录
node test/manifest.test.mjs  # 清单、patch、插槽 id 与代码注册是否一致
```

## 许可

MIT。`state.js` / `usage.js` / `pricing.js` 与桌面版共用。
