# 硬件事实取证记录

本插件的默认按键表**不是猜的**。这份文档记录每条结论的出处，以及它的可信程度。

标注约定：

- **【代码】**——来源是能读到的生产代码 / 设备档案 / 内核诊断记录；
- **【实测】**——来源是项目记录的实机测量结果；
- **【声明】**——来源只是项目 README 的叙述，未见代码佐证；
- **【推断】**——我们基于以上事实的推理。

如果你发现某条与你的设备不符，请带上固件批次和 `Get-PnpDevice` 输出提 issue。

---

## 1. 设备身份

| 事实 | 值 | 级别 | 出处 |
| --- | --- | --- | --- |
| 型号 | RC003（零售批次亦见 RC003-MS） | 【代码】/【声明】 | `nijez/open-voice-bridge` 的设备档案 `device-profiles/xiaomi-rc003.json`；驱动 README 的硬件 ID |
| 中文名 | 小米蓝牙遥控器 2 Pro / 小米蓝牙语音遥控器 2 Pro | 【代码】 | 同上 |
| 蓝牙名 | `MI RC`、`Xiaomi Bluetooth Remote 2 Pro`、`小米蓝牙语音遥控器` | 【代码】 | 设备档案 `identity.bluetoothNames` |
| VID / PID | `0x2717` / `0x32B8` | 【代码】 | 设备档案；驱动按此绑定 |
| 连接方式 | 单模 BLE，HID over GATT（HOGP） | 【代码】 | 硬件 ID 里的 `{00001812-…}` 就是 HOGP 服务 UUID |
| HID 顶层集合 | Generic Desktop / Keyboard（Usage Page `0x01`，Usage `0x06`） | 【代码】 | 多个项目的 HID 解析与内核诊断一致 |
| 是否存在 Consumer Control 集合 | 否 | 【代码】 | 多来源一致：Windows 没有为它创建 Consumer 集合 |

实例 ID 形状（用于按设备过滤时的匹配）：

```
HID\{00001812-0000-1000-8000-00805f9b34fb}_Dev_VID&012717_PID&32b8_REV&00a4
```

PnP 细节：节点在 `Enum\BTHLEDevice\…`，`Service = mshidumdf`，`LowerFilters = WUDFRd`，
`WUDF\DriverList = HidOverGatt`，`DeviceDesc = Bluetooth Low Energy GATT compliant HID device`。

> 注意：更便宜的 **ARN9 / 小米蓝牙语音遥控器（普通款）** 的蓝牙名与 RC003 相同，所以按名字匹配设备时必须留意区分。

---

## 2. 按键用途表（HID Usage Page 0x07）

这张表是本插件默认映射的**主要依据**，来自生产代码里的常量表与实机报告：

| 物理按键 | HID usage | Windows 上的表现 | 级别 |
| --- | --- | --- | --- |
| 语音 / 麦克风 | `0x003E` | **F5** | 【代码】+【实测】 |
| 确定 / OK | `0x0028` | Enter | 【代码】 |
| 上 | `0x0052` | ArrowUp | 【代码】 |
| 下 | `0x0051` | ArrowDown | 【代码】 |
| 左 | `0x0050` | ArrowLeft | 【代码】 |
| 右 | `0x004F` | ArrowRight | 【代码】 |
| 主页 | `0x004A` | Home | 【代码】 |
| 菜单 | `0x0065` | Application / ContextMenu | 【代码】 |
| 信号源 / TV | `0x0035` | 反引号 `` ` ``（Backquote） | 【代码】+【推断】 |
| 电源 | `0x0066` | 不确定（有项目需驱动改写才拿到） | 【代码】 |
| **返回** | `0x00F1` | **无**——被 `kbdhid.sys` 丢弃 | 【代码】+【实测】 |
| **音量 +** | `0x0080` | **无**——被 `kbdhid.sys` 丢弃 | 【代码】+【实测】 |
| **音量 −** | `0x0081` | **无**——被 `kbdhid.sys` 丢弃 | 【代码】+【实测】 |
| 静音 | `0x007F` | 表中存在，但没有任何项目记录过物理静音键 | 【代码】/存疑 |

关于语音键 = F5：这是本插件能"按住遥控器语音键说话"的关键。生产代码的按键表里明确写着
语音键在真实 Windows RC003 硬件上会以 Keyboard F5（usage `0x003E`）上报。

关于 TV 键 = 反引号：这是**推断**。`0x35` 在 HID Keyboard 页里是 `` ` `` / `~`，因此没有驱动改写时
Windows 应当把它翻译成反引号键。有项目的驱动把它改写成了 F18，侧面说明原始用法确实会被翻译成
"某个标准键"。本插件把它默认绑成"插入常用指令"，并用学习模式兜底——如果你的批次不是反引号，
按一下学习即可。

---

## 3. HID 报告布局

| 事实 | 值 | 级别 |
| --- | --- | --- |
| 键盘报告 ID | `0x01` | 【代码】 |
| 报告长度 | 描述符声明 `InputReportByteLength = 121`；键盘集合实际投递 9 字节 | 【代码】+【实测】 |
| 字段含义 | `report[1] = 修饰键`，`report[2] = 保留`，`report[3]` 起为按键 usage | 【代码】+【实测】 |
| 多键 | 9 字节形如 `01 00 00` + 三个小端 uint16 usage 槽位（0 表示空槽） | 【代码】 |
| 松键 | 松开发送全零载荷；若先按 A 再按 B，A 的零包可能被跳过 → 需要自动释放上一个键 | 【代码】 |

⚠️ 一个重要坑：这个设备有**两套**"键码"常量（一套主、一套 `_ALT`），因为不同固件 / 不同报告
路径用的值不一样（例如 主页 `0x4A` vs `0x24`、菜单 `0x65` vs `0x5D`、TV `0x35` vs `0xC0`、
语音 `0x3E` vs `0x04`）。本插件用的是**Windows HOGP 路径**那一套。

---

## 4. 三个键为什么收不到（"三键失效"）

**三个键是：返回 `0xF1`、音量 + `0x80`、音量 − `0x81`。**（不是菜单 / TV。）

### 机制

1. 遥控器确实把这三个 usage **声明并上报**在 `report_id = 0x01` 的键盘页范围内——用
   `HidP_GetButtonCaps` / `HidP_GetCaps` 枚举设备声明的 usage 可见它们；内核诊断也观察到过形如
   `01 00 00 80 00 …` 的报告。
2. Windows 的 `kbdhid.sys` 只把**能翻译成扫描码 / 虚拟键码的标准用法**转成输入事件。这三个 usage
   没有对应的翻译，于是它既不合成 VK，也不把原始报告继续往上转发。
3. 结果是报告止步于 HID 栈，**任何用户态 API 都看不到**：低级键盘钩子、Raw Input、
   `APPCOMMAND`、`SendInput` 观测，统统无效。

### 为什么没有旁路

| 尝试 | 结果 | 级别 |
| --- | --- | --- |
| 直接 `CreateFile` 打开键盘类 HID 接口 | 被拒。实测 17 个 HID 接口中 9 个（全部键盘类）`ERROR_ACCESS_DENIED`：键盘类顶层集合在 Windows 里是独占的，Raw Input Manager 会独占打开 | 【实测】 |
| 从 BLE 侧读 HOGP 的 GATT 特征 | `AccessDenied`。`00001812-…` 由 Windows HID 栈托管 | 【实测】 |
| 订阅厂商私有服务 `8a7a0001-2c42-c2a2-0f36-41928c259b78` | 三个 Notify 特征都能订阅成功，但按主页 / 返回 / 音量时**没有任何通知** | 【实测】 |
| 从 WUDFHost 侧做 IOCTL 旁路 | 至少在一台机器上没抓到 HID 报告；不能作为正式功能 | 【实测】 |
| 用 `/force` 禁用 HID 子设备 | Windows 把键盘子设备判为 critical，结果是**重启待生效**状态，不是可用的热切换 | 【实测】 |

### 可行的修复路径（本插件都不走）

1. **按设备过滤的 KMDF lower filter**，转发 `IRP_MJ_READ` 并在等长改写时把 `report[3]` 换成标准用法。
   已验证可行，但需要 TESTSIGNING + 关闭 Secure Boot，或 Microsoft attestation/WHCP 签名。
2. **按设备过滤的 UMDF upper filter**，fail-open 设计 + 用户态心跳（心跳停 2 秒就把按键原样放行）。
   有开源实现候选，但作者自己声明"不是可分发驱动"，签名与 HLK 都未完成。
3. **提权注入 WUDFHost**，hook `ntdll!NtDeviceIoControlFile`（`IoControlCode = 0x80018483`、
   `outputLength = 9`），在 `onEnter` 里清掉 offset 3 起的 usage 字节再把报告转发给应用。不需要驱动、
   不需要 TESTSIGNING，但需要特权辅助进程 + 每次授权，并且依赖未公开的 Windows 内部语义。

本插件选择**不提供假映射**，并在面板与设置页里说明原因和替代方案。

---

## 5. 语音链路：ATVV，且不是系统音频设备

| 事实 | 值 | 级别 |
| --- | --- | --- |
| 协议 | ATVV（Android TV Voice-over-BLE），**不是** Apple 的、也不是 HFP/HSP、也不是 LE Audio | 【代码】 |
| 服务 UUID | `ab5e0001-5a21-4f05-bc7d-af01f617b664` | 【代码】 |
| 写特征（命令下行） | `ab5e0002-…` | 【代码】 |
| 音频通知（上行） | `ab5e0003-…` | 【代码】 |
| 控制通知 | `ab5e0004-…` | 【代码】 |
| 麦克风在 Windows 上是不是录音端点 | **不是**。所有项目都必须自己实现 GATT 客户端 + ADPCM 解码 | 【代码】 |

握手（实测，十六进制）：

```
订阅 ab5e0003 + ab5e0004
写 ab5e0002 = 0A 01 00 00 03 03     （GET_CAPS v1.0）
  ← 控制 0B 01 00 00 03 00 78 00 00 （版本 1.0，codec 0x0003 = 8k & 16k，frame_size = 0x0078 = 120）
写 ab5e0002 = 0C 00                 （MIC_OPEN v1.0）
  ← 控制 04 00 02 00                （AUDIO_START，codec 0x02 = 16 kHz ADPCM）
按住语音键
  ← 控制 04 03 02 01                （AUDIO_START，reason = HTT）
  ← 120 字节音频帧开始
松开
  ← 控制 00 02                      （AUDIO_STOP，reason = HTT release）
写 ab5e0002 = 0D                    （MIC_CLOSE）
```

音频编码：

- **IMA/DVI ADPCM，4 bit/样本，高位优先**；
- **16 kHz 单声道**，120 字节/帧 = 240 样本 ≈ 15 ms；
- **无帧头**（不同于标准 ATVV v0.4 的 6 字节头），整帧都是 ADPCM 数据；
- **解码器状态跨帧连续**（初始 predictor = 0，step_index = 0）；
- `AUDIO_SYNC (0x0A)` 携带 predictor 与 step index，丢包时用来重新对齐。

两个坑：

- 遥控器用的是 **HTT（Hold-To-Talk，reason 0x03）** 模式，也就是**结束由设备决定**。有项目发现
  在 HTT 下发送标准的 `AUDIO_EXTEND (0x0E)` 保活指令会让遥控器的 ATVV 状态机崩溃（强行终止录音并
  发出伪造的松键事件）。所以不要发 `0x0E`。
- 单次录音上限约 **60 秒**，由设备控制。

**因为麦克风不是系统端点，每个 Windows 项目都要自己解决"音频怎么进到识别工具"**——主流做法是把解码后的
PCM 写进虚拟声卡（如 VB-CABLE 的 `CABLE Input`），再把语音工具指向 `CABLE Output`。

**本插件的选择**：v0.1 干脆**不用遥控器麦克风**，改用**系统默认麦克风**，把遥控器只当"按住说话"的按钮。
这样零虚拟声卡、零提权组件、装上就能用。代价是"拿着遥控器走远"这个场景暂时不支持——它明确写在
README 的路线图第 1 项里，并且上面的协议细节已经准备好，接的时候不用重新摸索。

---

## 6. 音频后处理惯例

各项目在 ADPCM 解码后普遍做同样的三步，本插件只做了其中的重采样与峰值归一化（因为音频来源不同）：

- 去削波（declip）；
- 三点低通 `[0.25, 0.5, 0.25]`（也有用 1-2-1 表述的，同一个东西）；
- 增益：实测 AGC 取 `min(30, 28000/peak)`，也有 ±24 dB 限幅、默认 +10 dB 的做法。

---

## 7. 本插件**没有**验证的东西

诚实清单：

1. **我们没有在真实 RC003 上跑过引脚级 / 内核级验证。** 上面的硬件事实来自别人的取证；本插件在这些
   结论之上做的是"用浏览器键盘事件接住可达按键"这件相对简单的事。
2. **TV 键 = 反引号是推断**，未实测。所以它默认绑一个无害的"插入常用指令"，并且可以学习覆盖。
3. **电源键在 Windows 上到底产生什么事件，本插件不假设**，默认不映射。
4. **静音键可能根本不存在**于某些批次。
5. **ATVV 未实现**，只做了资料准备。
6. **`0x80/0x81/0xF1` 的丢弃行为可能有固件差异。** 有项目在特定机器上连电源键都收不到，说明固件批次
   之间存在差异。本插件的做法是：不映射它们，并提供"按键日志 / 原始键码"让用户自己确认。

---

## 8. 出处

硬件事实来自下列项目（均为公开仓库）：

- `richlearntodo-debug/vibe-flow` —— 三键排查记录、输入路由根因分析、兼容性矩阵
- `ZSTDJan/windows-remote-mic-app` —— 按键用途表（默认映射的主要依据）、设备档案、HID 身份识别
- `QL-4/RemoteMapper` —— 内核级诊断：报告布局、`report[3]`、驱动改写对照表、GATT 服务全景、ATVV 握手
- `GetSayAll/remote-mic-app-windows` —— HID 独占访问实测数据、Raw Input 工程细节、延迟测量
- `cuicui-V5/RemoteMapper-ESP32` —— HOGP 报告格式、`_ALT` 键码、HTT 状态机与 `0x0E` 崩溃
- `nijez/open-voice-bridge` —— 设备身份档案、平台能力矩阵
- `xxb26553663-star/remote-bridge-hub`、`mwlt/Voice_VibeCoding` —— ATVV 实现与音频路由的交叉验证

DSH 侧的插件形态参考了磁盘上两个真实第三方插件：`dsh-effort-switcher`（Lane 1 客户端半区范例）与
`dsh-whale-widget`（Web 路由 + 信任栅栏经验）。
