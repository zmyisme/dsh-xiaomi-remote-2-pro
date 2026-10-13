# dsh-xiaomi-remote-2-pro

[![test](https://github.com/zmyisme/dsh-xiaomi-remote-2-pro/actions/workflows/ci.yml/badge.svg)](https://github.com/zmyisme/dsh-xiaomi-remote-2-pro/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

> 把 **小米蓝牙遥控器 2 Pro（RC003）** 变成 DeepSeek Harness 里的**按住说话语音输入**与**一键快捷控制台**。
> 40 块钱的蓝牙遥控器，一个 DSH 插件，零原生依赖、零管理员权限、离线识别。

<p align="center">
  <em>按住遥控器语音键说话 → 松开 → 文字落在 DSH 的输入框里。方向键滚会话，OK 发送，菜单换行。</em>
</p>

---

## 目录

- [它是什么](#它是什么)
- [能做什么](#能做什么)
- [工作原理](#工作原理)
- [安装](#安装)
- [快速上手](#快速上手)
- [默认按键映射](#默认按键映射)
- [配置项](#配置项)
- [按键学习模式](#按键学习模式)
- [给 Agent 用的接口](#给-agent-用的接口)
- [技术依据](#技术依据)
- [已知限制](#已知限制)
- [常见问题](#常见问题)
- [开发](#开发)
- [路线图](#路线图)
- [致谢](#致谢)
- [许可证](#许可证)

---

## 它是什么

这是一款 **DSH 插件**（不是独立程序）。装上之后：

- **遥控器的语音键就是"按住说话"**。按住 → DSH 开始录音；松开 → 识别成文字 → 落进当前会话的输入框；再按 OK 发送。
- **遥控器变成一个可编程的快捷键盘**。单击 / 双击 / 长按 / 按住松开四种手势，都可以绑到 13 种可执行动作上（插入文本、直接发送、滚动会话、模拟快捷键、清空草稿……），另有一个 `none` 用来显式屏蔽某个键。
- **配置在 DSH 界面里改**。设置页有完整的映射编辑器；一个悬浮快捷面板（遥控器一键呼出）显示实时状态与最近按键。
- **Agent 也能读改配置**。注册了 `remote_2_pro` 工具和 `/remote2pro` 命令，你可以直接让模型帮你调映射。

语音识别**复用 DSH 自带的语音输入**：选本地 SenseVoice 时音频不出机器、不联网、不需要 API Key。本插件自己不发起任何联网请求——如果你在 DSH 里把识别器切成云端 provider，那音频走的是 DSH 既有的云端通道，与普通语音输入完全一致。

与 [vibe-flow / Vibe Link](https://github.com/richlearntodo-debug/vibe-flow) 这类独立工具的区别：本插件不自己管音频设备、不调输入法、不装虚拟声卡。它只做一件事——**把遥控器接进 DSH**，语音识别交给 DSH 已经有的那套能力。

---

## 能做什么

| 能力 | 说明 |
| --- | --- |
| 按住说话 | 按住遥控器语音键（Windows 上就是 `F5`）开始录音，松开自动识别并插入光标处 |
| 四种手势 | 单击 / 双击 / 长按 / 按住松开，每个按键可分别配置 |
| 十三种可执行动作 | 插入文本、发送提示词、发送、换行、清空、滚动、模拟快捷键、开关面板、记录日志，以及两个默认关闭的高级动作（宿主机 HTTP / 执行命令）；另有 `none` 用于显式屏蔽 |
| 三套预设 | `vibe-coding`（推荐）、`navigation`（纯方向键不拦截）、`dictation`（只做听写） |
| 学习模式 | 遇到没有默认映射的按键（例如信号源键），点"学习"再按一下即可绑定 |
| 实时键码显示 | 面板与设置页显示收到的**原始键码**，方便判断某个键到底有没有被系统丢掉 |
| 悬浮快捷面板 | 显示设备状态、识别服务状态、最近按键、最近原始键码，带一键"按住说话"与"暂停接管" |
| 配置持久化 | 改动写回 profile，重启后仍在；拿不到 configEditor 时会明确告诉你"只在本次会话有效" |
| 模型可读写 | `remote_2_pro` 工具：查看状态、读配置、改预设、改/删映射、看日志 |
| 零原生依赖 | 纯 JavaScript。不用编译、不用管理员权限、不用改系统设置、不装驱动 |

---

## 工作原理

```
        ┌───────────────────────────────────────────────────────────────┐
        │  小米蓝牙遥控器 2 Pro（RC003，BLE HID / HOGP 键盘集合）        │
        └───────────────────────────┬───────────────────────────────────┘
                                    │ 标准 HID 键盘报告
                                    ▼
                     Windows 蓝牙 HID 栈（mshidumdf / kbdhid.sys）
                                    │ 能翻译成扫描码的用法 → 标准键盘事件
                                    │ 0x80 / 0x81 / 0xF1  → 被丢弃（见下）
                                    ▼
        ┌───────────────────────────────────────────────────────────────┐
        │  DSH 网页界面（客户端半区）                                    │
        │  keydown / keyup（捕获阶段）                                   │
        │    → 键码归一化（code → 逻辑按键）                             │
        │    → 手势识别（单击 / 双击 / 长按 / 按住松开）                  │
        │    → 动作执行                                                   │
        └───────┬───────────────────────────────────────┬───────────────┘
                │ 写入输入框 / 滚动 / 发送               │ POST /api/*
                ▼                                       ▼
        ┌───────────────────────┐         ┌───────────────────────────────┐
        │  DSH 会话输入框        │         │  宿主半区（Node）              │
        │  与消息流              │         │  配置持久化 / 设备探测 /       │
        └───────────────────────┘         │  日志环形缓冲 / Tool / 命令    │
                                          └───────────┬───────────────────┘
                                                      │ speechController.transcribe
                                                      ▼
                                           ┌───────────────────────────┐
                                           │ DSH 本地语音识别（SenseVoice）│
                                           └───────────────────────────┘

        语音链路：系统默认麦克风 → getUserMedia → MediaRecorder
                  → 解码 → 重采样到 16 kHz 单声道 → canonical WAV
                  → base64 → POST /api/transcribe → 文本 → 输入框
```

**为什么按键和录音都在浏览器侧？**

遥控器在 Windows 上就是一个标准的 BLE HID 键盘，它按下的键最终以**普通键盘事件**到达页面；麦克风用**系统默认录音设备**就行。这两件事浏览器都能直接做，于是整个插件：

- 不需要 C++ 扩展、不需要编译工具链、不需要匹配 Electron ABI；
- 不需要管理员权限，也不需要在系统里装任何东西；
- **完全绕开了** Windows 把 `0x80 / 0x81 / 0xF1` 三个 HID 用法丢掉的那一层（下面会解释）。

代价是：按键接管要求 DSH 窗口在前台。对"对着输入框说话"这个主场景来说，这恰好就是你要的。

---

## 安装

### 前置条件

| 项目 | 要求 |
| --- | --- |
| 系统 | Windows 10 / 11 x64 |
| DSH | 桌面版，或 `dsh web`（两者都可以） |
| 遥控器 | 小米蓝牙遥控器 2 Pro（型号 RC003，蓝牙名 `MI RC` / `Xiaomi Bluetooth Remote 2 Pro`） |
| 语音识别 | 建议先在 DSH 里启用实验性语音输入（本地 SenseVoice）。不启用插件也能跑，但语音相关功能不可用 |

### 第一步：在 Windows 里配对遥控器

1. 打开 设置 → 蓝牙和其他设备 → 添加设备 → 蓝牙。
2. 按住遥控器的 **主页 + 菜单** 键约 3 秒进入配对（不同批次略有差异，灯闪即进入配对）。
3. 选择 `MI RC` 或 `Xiaomi Bluetooth Remote 2 Pro`。

配对成功后**不需要**再装驱动，Windows 已经把它当成一个蓝牙键盘。装完插件后可以用面板里的"按键日志"确认系统确实收到了按键。

### 第二步：启用 DSH 的语音输入（可选但推荐）

设置 → 插件 → 找到实验性语音输入（`@deepseek-ai/dsh-experimental-voice-input-bundle`）→ 启用。
首次使用某个识别器时会下载本地模型，插件设置页里有一个「预下载 / 加载识别模型」按钮可以先把它热身好。

### 第三步：安装本插件

```powershell
# 桌面版
dsh plugin --profile desktop add github:zmyisme/dsh-xiaomi-remote-2-pro

# 或 dsh web
dsh plugin --profile web add github:zmyisme/dsh-xiaomi-remote-2-pro

# 本地开发（不用发布也能装）
dsh plugin --profile desktop add link:D:\path\to\dsh-xiaomi-remote-2-pro
```

<details>
<summary>手动安装（不用 CLI，已对照磁盘上的插件结构验证）</summary>

1. 把本目录放到某个位置，例如 `C:\Users\<你>\.dsh\plugins\dsh-xiaomi-remote-2-pro`。
2. 在 profile 目录（桌面版是 `C:\Users\<你>\.dsh\profiles\desktop\`）的 `package.json` 里：
   - 加一条依赖，指向本地目录或 git 地址；
   - 把 `dsh-xiaomi-remote-2-pro` 加进 `dsh.profile.bundles` 数组。
3. 重启 DSH。

`dsh.profile.bundles` 里的每个包，loader 都会应用它自己的 `cordis.patch.yml`，本插件的 patch 会把 `xiaomi-remote-2-pro` 这一行插进配置树。
</details>

### 第四步：重启 DSH

> ⚠️ **必须完整重启 DSH 进程**，刷新页面不够。
> `dsh.client` 的扫描只在启动时进行一次，热更新看不到新插件。

重启后打开 设置 → **小米遥控器 2 Pro**，应该能看到状态卡片。按一下遥控器方向键，设备状态会变成「活跃」。

---

## 快速上手

1. 打开一个会话，把光标点进输入框。
2. **按住遥控器语音键**（就是那个麦克风图标的键）说一句话。
3. 松开。文字出现在输入框里。
4. 按 **OK** 发送。

不习惯用遥控器语音键？输入框左边还有一个「说话」按钮可以按住说话。

---

## 默认按键映射

默认预设 `vibe-coding`：

| 遥控器按键 | 手势 | 动作 | 说明 |
| --- | --- | --- | --- |
| 语音键 | 按住 / 松开 | 按住说话 | 松开后识别并插入光标处 |
| 语音键 | 单击 | 开关悬浮面板 | |
| 确定 / OK | 单击 | 发送当前输入 | |
| 方向上 / 下 | 单击 | 向上 / 下滚动 320px | |
| 方向左 | 单击 | 跳到会话顶部 | |
| 方向右 | 单击 | 跳到会话最底部 | |
| 主页 | 单击 | 开关悬浮面板 | |
| 菜单 | 单击 | 换行（不发送） | |
| 信号源 / TV | 单击 | 插入一句常用指令 | 默认插入「请先复述我的需求，再给出最小改动方案。」 |
| 返回、音量 +、音量 −、静音 | — | **无映射** | Windows 会丢弃这些键，见下 |

### 为什么"返回"和"音量"没有映射？

这不是偷懒，是这三个键在 Windows 上**根本收不到**。

RC003 的返回键与音量键上报的是 HID Keyboard 页（Usage Page `0x07`）里的 `0xF1` / `0x80` / `0x81`。Windows 自带的蓝牙键盘驱动 `kbdhid.sys` 只为"能翻译成扫描码 / 虚拟键码的标准用法"生成输入事件，这几个用法不在其中，于是事件在**到达任何用户态程序之前**就被丢掉了：

- 低级键盘钩子（`WH_KEYBOARD_LL`）收不到；
- Raw Input 收不到；
- 浏览器 / 页面事件更收不到。

更麻烦的是，这条链路也没有旁路可走：

- 直接读 HID 设备：键盘类顶层集合在 Windows 里是**独占**的，`CreateFile` 会被 `ERROR_ACCESS_DENIED` 拒绝；
- 从 BLE 侧读 HOGP 的 GATT 特征：`00001812-…` 由 Windows HID 栈托管，读取返回 `AccessDenied`；
- 厂商私有服务 `8a7a0001-…` 虽然能订阅通知，但按键时**没有任何通知**；
- 强制禁用 HID 子设备：Windows 会把键盘子设备判为 critical，结果是重启待生效状态，不是可用的热切换。

所以本插件**不提供"看起来能用、实际永远不触发"的映射**。面板会把这些按键标成「系统丢键」，设置页底部也解释了原因和替代方案。

想要这三个键，只有两条路，代价都由你决定：

1. **按设备过滤的内核驱动**，在 `report[3]` 上把这三个用法改写成标准用法。需要关闭 Secure Boot 并使用测试签名（或用 Microsoft 硬件签名）。
2. **提权注入 WUDFHost**，在 HID 传输层把用法字节清掉再转发给应用。不需要驱动，但需要每次授权的特权组件，依赖未公开的 Windows 内部语义。

本插件两条都不走——因为一旦涉及测试签名或提权注入，它就不再是"装个插件"这么简单了。

---

## 配置项

设置 → 小米遥控器 2 Pro。所有改动即时生效并写回 profile。

### 顶层

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关 |
| `preset` | string | `vibe-coding` | `vibe-coding` / `navigation` / `dictation` / `custom` |

### `capture`（接管行为）

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 是否接管按键 |
| `onlyWhenPanelOpen` | boolean | `false` | 只在悬浮面板打开时接管 |
| `skipWhileTyping` | boolean | `true` | 焦点在输入框时，非语音按键交还 DSH（方向键仍然能移动光标） |
| `preventDefault` | boolean | `true` | 拦掉浏览器默认行为。**语音键是 `F5`，不开这个会刷新页面** |
| `doubleTapMs` | integer | `280` | 双击判定窗口（80–2000） |
| `longPressMs` | integer | `500` | 长按判定阈值（150–5000） |

### `voice`（语音）

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `language` | string | `auto` | `auto` / `zh` / `en` / `ja` / `ko` / `yue` |
| `providerId` | string | `''` | 空表示跟随 DSH 当前选择 |
| `autoSubmit` | boolean | `false` | 识别完成后直接发送 |
| `insertMode` | string | `composer` | `composer` 写入输入框 / `clipboard` 只复制 / `off` 只提示 |
| `maxSeconds` | integer | `30` | 单次录音上限（3–120） |
| `shortcut` | string | `ctrl+alt+space` | 麦克风快捷键，按住开始、松开结束 |
| `sampleRate` | integer | `16000` | 送往识别的采样率（8000–48000） |

### `mappings`（按键映射）

三层结构：`逻辑按键 → 手势 → 动作`。

```jsonc
{
  "mappings": {
    "voice": { "hold": { "kind": "dictate" }, "tap": { "kind": "panel" } },
    "ok":    { "tap": { "kind": "submit" } },
    "up":    { "tap": { "kind": "scroll", "direction": "up", "amount": 320 } },
    "tv":    { "tap": { "kind": "insertText", "text": "帮我看下这段代码的问题。" } }
  }
}
```

**手势**：`tap` 单击、`doubleTap` 双击、`longPress` 长按、`hold` 按住松开。
`tap` 与 `doubleTap` 同时配置时，单击会被延迟一个双击窗口再兑现（否则每次单击都会被误判成双击的前半段）。

**动作**：

| `kind` | 参数 | 说明 |
| --- | --- | --- |
| `none` | — | 明确不做事（用来屏蔽某个键）；归一化时会被丢掉 |
| `dictate` | — | 按住说话 → 识别 → 插入 |
| `dictateSubmit` | — | 按住说话 → 识别 → 插入并发送 |
| `insertText` | `text` | 插入固定文本 |
| `prompt` | `text` | 插入并直接发送（一键下达指令） |
| `submit` | — | 发送当前草稿 |
| `newline` | — | 插入换行，不发送 |
| `clear` | — | 清空草稿 |
| `key` | `chord` | 向页面派发快捷键，例如 `ctrl+k` |
| `scroll` | `direction`, `amount` | `up` / `down` / `top` / `bottom` |
| `panel` | — | 开关悬浮面板 |
| `log` | — | 只写日志（调试映射时用） |
| `http` | `url`, `method`, `body` | ⚠️ 由宿主机发请求，默认关闭 |
| `exec` | `command` | ⚠️ 在宿主机执行命令，默认关闭且受白名单限制 |

### `advanced`（高级，默认全部关闭）

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `allowHttp` | boolean | `false` | 允许 `http` 动作 |
| `allowExec` | boolean | `false` | 允许 `exec` 动作 |
| `execAllowlist` | string[] | `[]` | 命令前缀白名单。**空数组等于全部拒绝** |
| `logLimit` | integer | `200` | 日志条数上限（20–2000） |
| `deviceProbe` | boolean | `true` | 是否用 PowerShell 探测配对状态 |

> `exec` 刻意**不走 shell**：命令按空白切分后直接 `execFile(program, args)`。所以管道、重定向、`&&` 都不支持——这是有意的安全边界。

### `ui`

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `showIndicator` | boolean | `true` | 是否显示录音悬浮指示 |
| `showKeyLog` | boolean | `true` | 设置页是否显示按键日志 |
| `panelOpenByDefault` | boolean | `false` | 启动时是否自动展开悬浮面板（之后尊重你的手动开关） |

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `DSH_REMOTE2PRO_TRUSTED_HOSTS` | 逗号分隔。允许访问本插件 API 的非回环主机名 |

本插件的写接口默认**只接受回环 Host + 同源请求**，并拒绝 `Sec-Fetch-Site: cross-site`。如果你把 DSH 暴露在局域网里，除了设置这个变量，请自行在反向代理上加一层鉴权。

---

## 按键学习模式

万一某个按键的行为和你预期不一样（固件批次之间有差异），用学习模式现场绑定：

1. 设置页 → 按键映射 → 找到目标按键 → 点「学习」。
2. 面板提示"请按下…键"，此时按遥控器上那个键。
3. 绑定立刻保存。按 `Esc` 取消。

学习结果存在 `learnedCodes` 里，形如 `{ "F7": "tv" }`——即"这个键码当作哪个逻辑按键"。它优先于内置默认表，所以可以覆盖默认行为。

想知道某个键到底发出来什么？看设置页的**按键日志**或悬浮面板的「原始键码」一行。按了没反应，说明系统把它丢了。

---

## 给 Agent 用的接口

### 工具 `remote_2_pro`

| `action` | 参数 | 作用 |
| --- | --- | --- |
| `status` | — | 状态总览：配置、运行统计、语音服务、设备、不可达按键 |
| `get_config` | — | 读当前配置 |
| `set_config` | `patch` | 深合并补丁后校验并保存 |
| `set_preset` | `preset` | 切换预设 |
| `set_mapping` | `logicalKey`, `gesture`, `actionDefinition` | 设置一个映射 |
| `clear_mapping` | `logicalKey`, `gesture?` | 删除一个手势（或整键） |
| `recent_log` | `limit?` | 最近的按键 / 动作 / 识别日志 |

例：

> 「帮我把遥控器菜单键改成打开悬浮面板，然后把配置发我看看。」

模型会调用 `remote_2_pro`，`set_mapping` + `get_config` 就够了。

### 命令 `/remote2pro`

在输入框里敲 `/remote2pro`，打印一行行中文状态摘要：预设、接管开关、语音配置、识别服务可用性、最近按键、最近转写成败次数、当前映射表、系统丢键清单。

### HTTP API（面板自己用，也可供你写脚本）

所有路由在 `/dsh-remote2pro/api/` 下，全部经过信任栅栏：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/health` | 存活探测 |
| GET | `/state` | 面板的主数据源：配置、目录、运行统计、日志、语音、设备 |
| GET | `/device` | 强制/缓存探测 PnP 配对状态（`?force=1`） |
| POST | `/config` | 深合并并保存配置 |
| POST | `/learn` | 保存 / 删除学习绑定 |
| POST | `/log` | 客户端上报日志（`{clear:true}` 清空） |
| POST | `/prepare` | 预热一个识别器（首次会下载模型） |
| POST | `/transcribe` | `{audioBase64}` → `{text}` |
| POST | `/host-action` | `http` / `exec` 动作的宿主侧执行入口 |

---

## 技术依据

本项目里的硬件事实不是猜的。以下结论来自多个独立项目的**生产代码与内核级诊断**，交叉验证后才写进默认表：

| 结论 | 依据 |
| --- | --- |
| `VID 0x2717 / PID 0x32B8`，BLE HID（HOGP）键盘集合 | 硬件 ID `HID\{00001812-…}_Dev_VID&012717_PID&32b8_REV&00a4`，`00001812` 即 HOGP 服务 UUID |
| 语音键 = HID Keyboard usage `0x003E`，Windows 上表现为 **F5** | 生产代码中的按键用途表 + 实机报告 |
| 返回 `0xF1`、音量 `0x80` / `0x81` 被 `kbdhid.sys` 丢弃 | 三个独立项目的实测记录 + 内核诊断（这三个 usage 确实存在于 HID 报告中，只是没有扫描码翻译） |
| 键盘类 HID 顶层集合是独占的，无法旁路读取 | 实测 17 个 HID 接口中 9 个键盘类接口 `CreateFile` 被拒；HOGP 特征读取 `AccessDenied` |
| 遥控器麦克风**不是** Windows 音频端点 | 它走 ATVV（Android TV Voice-over-BLE）私有 GATT 通道，`ab5e0001-…` / `ab5e0002` / `ab5e0003` / `ab5e0004` |
| 单击 / 双击 / 长按 / 按住松开的手势模型 | 社区里同类工具的共同做法；本插件把它做成了纯函数并带单元测试 |

关于语音链路的一个重要说明：因为遥控器麦克风不是系统音频设备，**v0.1 用的是电脑的麦克风**（系统默认录音设备），遥控器只当"按住说话"的按钮。所以：

- 遥控器放在手边、电脑麦克风能收到你的声音 → 体验和独立工具一样；
- 你想拿着遥控器走到房间另一头说话 → 现在不行，需要实现 ATVV 客户端（见[路线图](#路线图)）。

我们选择先把"零依赖、装上就能用"这条路走通，而不是先做一个需要虚拟声卡 + 提权组件才能跑的 ATVV 版本。

---

## 已知限制

这一节请务必读完，它决定了这个插件**不适合**什么场景。

1. **必须让 DSH 窗口保持前台**。按键接管依赖页面的键盘事件；DSH 在后台时遥控器只是普通键盘，按键会打到当前活动窗口。对"对着输入框说话"这个主场景这是正确的，但**不能**用来在后台全局操控 DSH。
2. **无法区分"这个键来自遥控器"还是"来自你的物理键盘"**。浏览器不提供设备身份信息。因此：语音键绑定在 `F5` 之后，**你物理键盘上的 F5 也会触发录音**。我们用两个办法缓解——`skipWhileTyping`，以及把默认动作设计成幂等（比如发送、滚动）；但这是真实存在的取舍。如果你常用 F5，建议把 `voice` 的映射改到别的键，或用面板按钮 / 快捷键触发录音。
3. **返回键、音量键、静音键在 Windows 上收不到**，原因见上文。面板会标注它们，不会给假映射。
4. **语音用的是电脑麦克风，不是遥控器的麦克风**（v0.1）。
5. **向输入框插入文字依赖 DOM**。DSH 目前没有公开"写入草稿"的客户端服务，所以插入是"找可见输入框 → 用原生 setter / `execCommand` 写入 → 派发 input 事件"。React 受控组件走这条路是可行的，但它依赖界面结构：**DSH 前端改版可能让它失效**。失效时的表现是明确的——文字会被复制到剪贴板并提示你手动粘贴，而不是静默失败。找不到输入框时也可以把 `voice.insertMode` 改成 `clipboard`。
6. **日志环形缓冲的容量在插件加载时固定**。改 `logLimit` 需要重载插件（重启）后才生效。
7. **手势有固有延迟**：单击在配了双击的按键上会晚一个 `doubleTapMs`（默认 280ms）兑现。只配单击则无延迟。
8. **`exec` 不支持 shell 语法**（管道、重定向、`&&`），这是刻意的。
9. **仅 Windows**。设备探测走 PowerShell；按键与语音链路本身是跨平台的，但没在别的系统上验证过，所以不声明支持。
10. **首次使用语音会下载本地模型**（几百 MB，取决于识别器）。设置页里有预热按钮，建议先点一下。

---

## 常见问题

**按遥控器完全没反应？**

1. 看设置页「按键日志」有没有出现原始键码。有 → 是映射问题，用学习模式或改映射。
2. 没有 → 系统层面就没收到。确认遥控器已在 Windows 蓝牙设置里配对、DSH 窗口在前台、`capture.enabled` 是开的。
3. 确认总开关和预设没有把接管关掉（`navigation` 预设只接管语音键）。

**按语音键页面刷新了？**

`capture.preventDefault` 被关掉了。语音键在 Windows 上是 `F5`，必须拦掉默认行为。到设置页把它打开。

**按住语音键说话，识别出来是空的？**

- 电脑麦克风没权限 / 没选对设备。浏览器第一次会弹权限请求；`insertMode` 之外，还要确认系统默认录音设备不是静音的。
- 或者 DSH 的语音输入没启用。设置页会有一个醒目提示，告诉你识别服务不可用。

**识别结果没落进输入框？**

说明没找到输入框。确认光标在 DSH 的会话输入框里；如果界面刚改过版导致定位失效，插件会把文字复制到剪贴板并提示你粘贴。也可以直接把 `voice.insertMode` 设成 `clipboard`。

**改了配置，重启后没了？**

面板顶部会提示"宿主没有 configEditor，改动只在本次会话内有效"。这通常意味着当前 DSH 版本没有提供 `configEditor` 服务，改动无法写回 profile。此时可以手工编辑 profile 里的 `config`。

**悬浮面板挡住了东西？**

按主页键或语音键单击收起；也可以在设置里把 `ui.panelOpenByDefault` 关掉。面板在左下角，避开了一些插件占用的右下角。

**和别的遥控器插件冲突吗？**

同一个遥控器同一时间只能被一个 BLE 连接使用。本插件不建立 BLE 连接（它只用系统已经建好的 HID 通道），所以不会抢占设备；但如果另一个工具抢了 HID 独占或改了系统默认录音设备，两边都会受影响。

---

## 开发

### 目录结构

```
dsh-xiaomi-remote-2-pro/
├── package.json          # dsh 清单：bundle patch + client（platform/inject）+ exports
├── cordis.patch.yml      # 挂载声明，把本插件插进 profile 配置树
├── host.js               # 宿主半区：HTTP API / 配置持久化 / 设备探测 / Tool / 命令
├── client.js             # 客户端半区：Lane 1（Module Loader 包），按键 / 手势 / 语音 / UI
├── lib/
│   ├── keys.js           # RC003 按键模型 + HID usage 表 + 键码归一化 + 快捷键解析
│   ├── mapping.js        # 动作目录 + 手势识别引擎（纯函数，时间由调用方注入）
│   ├── config.js         # 默认值 / 预设 / 容错归一化 / Standard Schema
│   ├── wav.js            # WAV 编解码 + 重采样 + 转写前校验（两个半区共用）
│   ├── fence.js          # 路由工具 + 信任栅栏（回环 / 同源 / Sec-Fetch-Site）
│   ├── device.js         # PnP 设备探测（PowerShell + EncodedCommand，带缓存）
│   └── runtime.js        # 日志环形缓冲 / 语音桥 / 配置存储 / 运行统计
├── test/                 # 139 个用例，node --test 直接跑，无需安装任何依赖
├── docs/
│   ├── ARCHITECTURE.md   # 分层、数据流、为什么这样切
│   └── EVIDENCE.md       # 上表每一条结论的出处与原文摘录
├── .github/workflows/ci.yml   # Windows + Ubuntu × Node 20/22，零安装直接跑测试
├── README.md / README.en.md   # 中文主文档 / 英文文档
└── LICENSE
```

### 跑测试

```powershell
node --test          # 139 个用例
node --check host.js; node --check client.js
```

测试**零依赖**：不需要 `npm install`，不需要构建。`node --test` 直接用 Node 内置 runner。

覆盖范围包括：手势引擎的每一种组合与边界（自动重复、双击窗口、长按与单击的互斥）、13 种动作的最小可用配置、配置归一化的降级路径、WAV 编解码与坏输入、信任栅栏的各种绕过尝试、设备探测的失败回落、宿主全部路由与 Tool，以及**把 `client.js` 放进 `vm` 里真的加载一遍**，验证它注册了三个 slot、挂上了按键监听、并把一次按键走完了"键码 → 手势 → 动作"整条链路。

### 设计约定

- **纯逻辑与副作用分离**：`lib/` 里的东西不碰 DSH、不碰浏览器、不碰 Node，所以能被两个半区复用并被单元测试直接覆盖。手势引擎连时间都是注入的。
- **零运行时依赖**：`dependencies` 和 `devDependencies` 都是空的。宿主侧只用 `node:` 内置模块，客户端侧只 `require("react")`。
- **容错优先于严格**：配置里任何一处非法，都降级 + 记警告，**绝不让插件激活失败**。用户看到的应该是一条能读懂的提示，而不是空白面板和堆栈。
- **失败必须说出来**：找不到输入框 → 复制到剪贴板并提示；识别器不可用 → 明确告诉你启用哪个插件；音频解码不了 → 说清原因。没有静默失败。

### 本地开发循环

DSH 用包名解析插件，而包管理器规范对路径里的空格处理容易出岔子。开发目录若含空格，先建一个不含空格的中转 junction：

```powershell
New-Item -ItemType Junction `
  -Path "C:\Users\<你>\.dsh\plugins\dsh-xiaomi-remote-2-pro" `
  -Target "D:\path\to\dsh-xiaomi-remote-2-pro"

dsh plugin --profile desktop add link:C:\Users\<你>\.dsh\plugins\dsh-xiaomi-remote-2-pro
```

**改任何代码都要完整重启 DSH 进程**，刷新页面不够。这是实测结论，不是保守说法：

- 改 `client.js`：`dsh.client` 的扫描只在启动时做一次；
- **改 `host.js` 或 `lib/*` 也一样要重启。** 在运行中的 DSH 里把 bundle 禁用再启用，确实会让插件重新 `apply()`（路由也能干净地释放重建），但 **Node 的 ES 模块缓存不会失效**，跑的还是旧代码。想确认自己到底在跑哪一份，看 `remote_2_pro` 的 `status` 或 `/api/state` 里的 `version` 字段。

重启后可以在 `status` 里看到 `version`（与 `package.json` 一致，有测试保证），用来核对。

---

## 路线图

按优先级：

1. **ATVV 语音链路**：实现遥控器自身麦克风的音频采集，让"拿着遥控器在房间另一头说话"成立。已完成前期取证：服务/特征 UUID 是 `ab5e0001-5a21-4f05-bc7d-af01f617b664` 下的 `ab5e0002`（写）/ `ab5e0003`（音频通知）/ `ab5e0004`（控制通知），握手是 `0A 01 00 00 03 03` → `0C 00`，音频为 **headerless、高位优先的 IMA/DVI ADPCM、120 字节一帧、16 kHz 单声道**，解码器状态跨帧连续。剩下的工作是 WinRT BLE 通道 + 把 PCM 送进 DSH 的识别服务。
2. **可选的全局接管**：为需要后台操控的用户提供一个可选的原生辅助进程（Raw Input + `RIDEV_INPUTSINK`，按 `VID_2717&PID_32B8` 绑定设备实例），这样终于能区分遥控器与物理键盘。
3. **每个会话独立的映射**：按会话 / profile 切换按键方案。
4. **导出与分享配置**：一键导出 JSON 映射方案。
5. **更多遥控器**：ARN9、T1、汉王 V60 等同类 BLE HID 遥控器的按键表。

---

## 致谢

这个插件的硬件事实建立在下面这些项目公开的实测结果之上。它们各自用完全不同的技术栈（Rust / Python / C# / Swift / ESP32 固件）踩出了同一批坑，才让"哪些键收得到、哪些收不到"变成可验证的结论：

- [richlearntodo-debug/vibe-flow](https://github.com/richlearntodo-debug/vibe-flow)（Vibe Link）—— 本项目的灵感来源，且完整记录了三键丢失的排查过程与放弃决策
- [ZSTDJan/windows-remote-mic-app](https://github.com/ZSTDJan/windows-remote-mic-app) —— 生产级的 RC003 按键用途表，是默认映射表的主要依据
- [QL-4/RemoteMapper](https://github.com/QL-4/RemoteMapper) —— 内核级诊断，确认了 HID 报告布局与"usage 在 `report[3]`"
- [GetSayAll/remote-mic-app-windows](https://github.com/GetSayAll/remote-mic-app-windows) —— HID 独占访问的实测数据与 Raw Input 的工程细节
- [cuicui-V5/RemoteMapper-ESP32](https://github.com/cuicui-V5/RemoteMapper-ESP32) —— ATVV 状态机与 HOGP 报告格式的一手记录
- [nijez/open-voice-bridge](https://github.com/nijez/open-voice-bridge) —— 设备身份档案（蓝牙名、VID/PID）
- [xxb26553663-star/remote-bridge-hub](https://github.com/xxb26553663-star/remote-bridge-hub)、[mwlt/Voice_VibeCoding](https://github.com/mwlt/Voice_VibeCoding) —— ATVV 与音频路由的交叉验证

DSH 插件形态参考了两个真实存在的第三方插件：`dsh-effort-switcher`（Lane 1 客户端半区的完整范例）与 `dsh-whale-widget`（Web 路由 + 信任栅栏的工程经验）。

---

## 许可证

[MIT](LICENSE)

---
