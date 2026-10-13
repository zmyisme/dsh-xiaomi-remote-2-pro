# 架构说明

这份文档解释**为什么**代码被切成现在这样。想知道**怎么用**，看 [README](../README.md)。

---

## 一、两个半区，一条边界

DSH 插件天然分成两半，本插件把边界划在"谁离硬件近"上：

| | 宿主半区 `host.js` | 客户端半区 `client.js` |
| --- | --- | --- |
| 运行位置 | Node（Electron 主进程或 `dsh web` 进程） | DSH 网页界面 |
| 负责 | HTTP API、配置持久化、设备探测、调用语音识别、Tool、人类命令 | 按键接管、手势识别、动作执行、录音、UI |
| 不负责 | 键盘事件、麦克风、DOM | 写文件、读 PnP、持久化 |

**按键与麦克风都留在浏览器侧**，这不是偷懒，而是整个插件能"零依赖"的唯一原因：

- 遥控器在 Windows 上就是标准 BLE HID 键盘 → 它的按键最终是普通键盘事件 → 页面直接能拿到；
- 麦克风用系统默认录音设备 → `getUserMedia` 直接能用。

于是不需要 C++ 扩展（不用编译、不用匹配 Electron ABI）、不需要管理员权限、不需要原生音频桥。同时**绕开了 Windows 丢弃 `0x80/0x81/0xF1` 的那一层**——那三个 usage 在到达用户态之前就没了，我们不去正面解决它，而是不依赖它。

代价写在 README 的「已知限制」里：接管要求 DSH 窗口在前台。对"对着输入框说话"这个主场景，这恰好是正确的语义。

---

## 二、客户端 ↔ 宿主怎么通信

只有一条路：**本插件自己的 HTTP 路由**（`fetch`）。

考虑过但没用的两条：

- **`host.call`（Lane 2 的 `cordis-client-runner` 闭包）**——需要宿主侧用 `harness.handle` 注册处理器，而第三方包能否使用 `harness.handle` **尚未验证**。不把未验证的东西放进架构。
- **直接注入别的插件的客户端服务**——`slots` 之外的客户端服务没有稳定文档，且官方插件开发规范明确要求"不要读别的插件的 DOM / 样式 / 组件源码"。

所以采用已被真实第三方插件验证过的通道：`ctx.webServer.register(...)` + `fetch`。

### 客户端半区为什么是 Lane 1

DSH 的浏览器侧有两条实现路径：

- **Lane 1**：`dsh.client` 清单 + `exports["./client"]`，产物必须调用 `window.__ModuleLoader__.load({ id, factory })`，`id` 必须等于包名（loader 强制校验）。工厂拿到 `require`（白名单里有 `react`）和 `ctx`。
- **Lane 2**：`cordis-client-runner` 闭包，是一段纯 JS 异步函数体，拿到固定的 `React` / `console` / `styles` / `host` / `ctx`，**没有 `require`，也没有 `fetch`**。

本插件走 **Lane 1**，理由：

1. 它是 loader 对 `dsh.client` 包**强制执行**的形态；
2. 所有官方客户端插件都是这个形态，兼容性最确定；
3. 它仍有 `ctx`，因此可以用 `ctx.slots` / `ctx.inject`，也就是能**真正接进 DSH 的界面**（而不是自己往 `document.body` 上挂 DOM——官方规范明确禁止那样做）。

Lane 1 的代价是拿不到 `host.call`，这正好由 HTTP 路由补上。

---

## 三、注册到哪些 slot

| slot | 组件 | 作用 |
| --- | --- | --- |
| `shell.overlay` | `Overlay` | 浮在整个框架之上的层：录音指示、提示条、悬浮快捷面板 |
| `conversation.input.left` | `MicButton` | 输入框工具栏左侧的"按住说话"按钮 |
| `settings.section` | `SettingsPage` | 设置面板里的一个完整配置页 |

选择理由：

- `shell.overlay` 的定位是"框架级浮动层，在所有列之上、在各列的滚动容器之外"，正适合**不属于任何一列**的悬浮面板与录音指示；
- 悬浮面板刻意放**左下角**，避开常见插件占用的右下角；
- 配置页用 `settings.section`（"每个条目一个设置页"），而不是更碎片的 `settings.general.item`——因为配置项足够多，值得一整页。

所有 slot 注册都包在 `try/catch` 里：官方文档警告"抛异常的组件会让那个 slot 条目变空"，所以一个 slot 注册失败不应该连累其它两个。

样式在**模块加载时**注入一次 `<style data-plugin-css=...>`（Lane 1 的通行做法，因为客户端沙箱不保证会跑 effect 回调），并全部使用 `--dsw-alias-*` 主题 token，因此跟随 DSH 的明暗主题。

---

## 四、纯逻辑与副作用分离

```
lib/keys.js      纯数据 + 纯函数        ─┐
lib/mapping.js   纯函数（时间注入）      ├─ 两个半区共用，单元测试直接覆盖
lib/wav.js       纯函数（无 Buffer 假设）─┘
lib/config.js    纯函数 + Standard Schema
lib/fence.js     HTTP 工具 + 安全校验      ── 仅宿主
lib/device.js    PowerShell 探测（注入执行器）── 仅宿主
lib/runtime.js   日志 / 语音桥 / 配置存储    ── 仅宿主
```

`lib/mapping.js` 里的手势引擎**连时间都是注入的**（`down(key, now)` / `tick(now)` / `nextDeadline()`），自己不起定时器。好处：

- 双击窗口、长按阈值这些时序逻辑可以在 Node 里**确定性地**测试，不用 `await sleep`；
- 浏览器侧只需要按 `nextDeadline()` 安排一次 `setTimeout`，逻辑不重复；
- 面板关闭 / 配置变更时 `reset()` 即可清干净。

`client.js` 需要手势引擎的浏览器副本（Lane 1 里没法 `import` 本地文件），这是有意接受的一处重复；缓解办法是**默认键码表只从宿主目录取**（`/api/state` 里的 `catalog.defaultCodeMap`），客户端里的常量只作兜底。

---

## 五、安全模型

插件里有两条会写东西的路由（`/config`、`/learn`）和两条会干实事的路由（`/transcribe`、`/host-action`）。保护分三层：

### 1. 信任栅栏（`lib/fence.js`）

顺序是刻意的：

1. **插件自己的校验永远先跑**：Host 必须是回环（逐段校验 IPv4，防 `127.0.0.1.evil.com`）或在 `DSH_REMOTE2PRO_TRUSTED_HOSTS` 里；拒绝 `Sec-Fetch-Site: cross-site`；有 `Origin` 时必须与 Host 同源。
2. 宿主栅栏 `ctx.connection.requestRejection(req)` 可用 → 委托它，返回码照用。
3. 宿主栅栏**抛异常 → 按拒绝处理**，绝不 fail-open。

第 3 条不是假想：社区里已有插件因为"服务缺失"和"自己抛异常"两条路径都放行，导致 22 条路由集体失去校验（其中还包括能读写凭据的路由）。

栅栏对 `connection` 服务是**惰性取值**的：Cordis 的服务就绪顺序不确定，如果在构造时快照服务，早于 `connection` 就绪的实例会永远以为宿主没有栅栏。

### 2. 危险动作默认关闭

- `http` / `exec` 动作默认**关闭**（`advanced.allowHttp` / `allowExec`）。
- `exec` 的**白名单为空等于全部拒绝**。
- `exec` 不走 shell：`command.split(/\s+/)` 后直接 `execFile(program, args, { timeout, maxBuffer })`。管道、重定向、`&&` 自然都不支持——这是刻意的边界，不是缺陷。
- `http` 动作只允许 `http(s)`，带超时。

### 3. 输入校验

- 请求体有大小上限（默认 12 MB，日志接口 256 KB）；
- 转写前用 `lib/wav.js` 真解析 WAV 头，校验声道、位深、时长与大小，坏音频**不会**送到识别器；
- 配置写入前一定过一遍 `normaliseConfig`，非法字段降级并记警告。

---

## 六、容错策略：为什么配置是"宽松归一化"

DSH 在加载插件时会用 `Config`（Standard Schema v1）校验 profile 里的 `config`。如果校验直接报错，插件在 profile 里就会**激活失败**——用户看到的是空白和堆栈。

所以策略是：

- 只有"整份配置根本不是对象"才返回 `issues`（与官方插件的做法一致）；
- 其余一律**归一化 + 降级**：非法字段回落到默认值，问题收集进 `warnings`，面板里直接可见；
- `validate()` 返回的 `value` 就是**归一化后的完整配置**，插件内部不用再写兜底默认值。

好处是 `profile` 永远能正常加载，坏配置变成一条可读的提示而不是一次启动失败。

同样的原则贯穿全项目：**没有静默失败**。找不到输入框 → 复制到剪贴板并提示；识别器不可用 → 说清要启用哪个插件；音频解码不了 → 说清原因。

---

## 七、数据流：一次"按住说话"

```
① keydown(F5)
   ├─ 学习模式？ → 绑定 code → logicalKey，结束
   ├─ 命中 voice.shortcut？ → 开始录音
   ├─ shouldIgnore？ → 输入框内非语音手势一律放行给 DSH
   └─ 手势引擎 down() → hold/press → runAction('dictate','press')
                                   → recorder.start()
                                      getUserMedia → MediaRecorder.start()
                                      POST /api/log {voice,start}（异步批量）

② keyup(F5)
   └─ 手势引擎 up() → hold/release → runAction('dictate','release')
                                   → stopDictationWithSubmit()
                                      MediaRecorder.stop() → Blob
                                      AudioContext.decodeAudioData
                                      → 单声道 → 重采样 16 kHz → 峰值归一化
                                      → encodeWav → base64
                                      → POST /api/transcribe
                                          宿主：validateTranscriptionAudio
                                               speechController.transcribe
                                               → SenseVoice → 文本
                                      → insertTextInto(composer)
                                      → 可选 submitComposer()
```

音频格式是 **canonical WAV**（16-bit PCM 单声道 base64）——这是 DSH `speechController.transcribe`
的 `TranscriptionRequest` 明确要求的形状。

---

## 八、已知的架构风险

诚实列出，方便后续接手：

1. **DOM 插入是唯一不"干净"的地方**。DSH 没有公开"写入草稿"的客户端服务，所以只能找 DOM。风险与兜底策略见 README 已知限制第 5 条。
2. **客户端里的默认键码表与 `lib/keys.js` 存在重复**。已通过"优先用宿主下发的目录"把实际影响降到零，但常量本身还在。
3. **`ui.showIndicator` 等 UI 开关需要客户端读配置**，而配置是从 `/api/state` 轮询来的，所以插件刚加载的头几百毫秒内 UI 用的是默认值。
4. **环形缓冲容量在加载时固定**，改 `logLimit` 需要重载。
5. **ATVV 未实现**，所以遥控器麦克风用不上（README 路线图第 1 项）。
