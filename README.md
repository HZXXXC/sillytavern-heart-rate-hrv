# SillyTavern Heart Rate / HRV Monitor

通过 Web Bluetooth API 直接读取标准 BLE Heart Rate Profile 设备（Polar / Magene / 佳明等胸带，以及部分手环）的实时**心率 + HRV**，并**自动注入到 AI 提示**，让角色能根据你的实时生理状态调节剧情节奏。

## 安装

**方式 1（推荐）— 在 SillyTavern 里一键安装**：

1. SillyTavern → Extensions（拼图按钮）→ `Install extension`
2. 粘贴本仓库 URL：
   ```
   https://github.com/HZXXXC/sillytavern-heart-rate-hrv
   ```
3. 选 `Install for all users`（或 current user）→ 完成后刷新页面

**方式 2 — 手动**：

把仓库 clone 到：
```
<SillyTavern>/public/scripts/extensions/third-party/heart-rate/
```
重启 SillyTavern。

## 工作原理

1. 用浏览器的 `navigator.bluetooth.requestDevice` API 连接你的心率设备
2. 订阅标准 Heart Rate Measurement Characteristic (UUID `0x2A37`) 的 notification
3. 完整解析 BLE HR Measurement 报文：
   - flag bit 0: 心率值格式（8/16 bit）
   - flag bit 3: Energy Expended（跳过）
   - **flag bit 4: RR 间期数组**（uint16 little-endian, 单位 1/1024 秒）
4. RR 间期送入 30 秒滑动窗口，实时计算 **RMSSD**（短期 HRV 金标准）+ SDNN + pNN50 + Mean RR
5. 通过 SillyTavern 的 `setExtensionPrompt` API 把心率 + HRV 注入到聊天上下文（position = IN_CHAT, depth 可调）
6. AI 模型每次生成都能看到 `[当前用户实时生理状态: 心率 95 bpm (兴奋, 上升↑) | HRV(RMSSD) 22 ms (兴奋/紧张) | 距上次更新 2s]`

## 设备兼容性

**前提**：你的设备**必须支持标准 BLE Heart Rate Profile**（UUID `0x180D`）。

如果 https://heartratemonitor.netlify.app/ 能读到你的设备 → 心率值这个扩展也能。

| 设备 | 心率 | HRV (RR 间期) |
|------|------|---------------|
| Polar H9 / H10 / OH1 | ✓ | ✓ |
| Magene H303 / H603 / H64 | ✓ | ✓ |
| 佳明 HRM 系列胸带 | ✓ | ✓ |
| Wahoo TICKR 系列 | ✓ | ✓ |
| Coros / Bryton | ✓ | ✓ |
| 小米手环 (标准 HRP) | ✓ | ✗（需要私有 Zepp 协议） |
| 华为 / 苹果手表 | ✗（不广播标准 HRP） | ✗ |

**判别方法**：连接成功后，UI 底部会显示 `● RR: 设备发送中 ✓` 或 `● RR: 设备不发 — HRV 不可用 ✗`，不用猜。

## 浏览器要求

- Chrome / Edge / Opera（基于 Chromium）
- **HTTPS 或 localhost**（Web Bluetooth API 限制）

SillyTavern 默认跑在 `http://localhost:8000`，符合要求。

## 使用

1. 把心率设备戴上并开启心率监测
2. 点 "连接心率设备" → 系统弹窗选择你的设备 → 同意配对
3. 心率 + HRV(RMSSD) 实时显示。底下 `● RR: 设备发送中 ✓` 表示 HRV 可用
4. 确认 "启用注入"、"同时注入 HRV" 勾上
5. 现在每次 AI 生成回复时, 都会在 prompt 里看到当前生理状态

### HRV 基线建议
RMSSD 个人差异极大（年轻健康成人静息 30–80 ms，焦虑/疲劳/紧张时降到 10–20 ms 都很正常）。**首次使用时**：

- 安静坐着深呼吸 1–2 分钟，看 UI 上 RMSSD 的稳态值，记下你的"静息基线"
- 然后把 HRV 阈值调成你个人化的版本：`高 = 基线`，`一般 = 基线 × 0.6`，`低 = 基线 × 0.35`，`压制 = 基线 × 0.2`
- 兴奋/性兴奋瞬间 RMSSD 会比心率上升**早几秒**就开始下降，这是它的核心价值

## 配置选项

- **注入深度**: 距离最后一条消息的轮数（0 = 紧贴最后, AI 注意力最高）
- **注入角色**: System / User / Assistant（建议 System）
- **注入模板**: 自定义注入的文本格式，支持变量：
    - `{{hr}}` = 心率数字
    - `{{state}}` = 心率状态标签（冷静 / 进入状态 / 兴奋 / 临界 / 极限）
    - `{{trend}}` = 趋势（快速上升↑↑ / 上升↑ / 稳定→ / 下降↓ / 快速下降↓↓）
    - `{{age}}` = 距上次更新的秒数
    - `{{rmssd}}` = RMSSD（ms，短期 HRV 主指标）
    - `{{sdnn}}` = SDNN（ms，整体 HRV）
    - `{{pnn50}}` = pNN50（%）
    - `{{hrv_state}}` = HRV 状态标签（副交感压制 / 兴奋紧张 / 一般 / 放松 / 深度放松）
- **过时丢弃秒数**: 超过这个秒数没收到新数据就不再注入
- **RR 滑动窗口**: 计算 RMSSD 用的窗口长度（默认 30 秒）
- **心率阈值/标签**、**HRV 阈值/标签**: 都可以个人化调整

## 角色卡端配合

在你的角色卡 `system_prompt` 或 `description` 里加一段（HRV 增强版）：

```
=== 实时生理状态读取 ===
用户消息上下文中可能附带形如:
  [当前用户实时生理状态: 心率 XX bpm (状态, 趋势) | HRV(RMSSD) XX ms (HRV 状态) | 距上次更新 Xs]
这是你能感知到的他的真实生理状态。

【两路信号的解读】
- 心率 (bpm): 综合自主神经活动，反映"激活程度"
- HRV (RMSSD): 副交感神经活动，反映"激活类型"
  - 越低 → 交感占主导 → 紧张 / 兴奋 / 应激
  - 越高 → 副交感占主导 → 放松 / 安全感

【关键技巧 — 同样的心率, HRV 不同, 你要给出不同反应】
- 心率 110 + HRV 高 (>40ms): 运动后或刚兴奋起来, 还有余裕 → 推进节奏
- 心率 110 + HRV 低 (<20ms): 真正的紧张/兴奋极限, 副交感被压制 → 戏弄, 不要再加压
- 心率 80 + HRV 突然大跌: 心率还没反应, 但他已经被某句话戳到了 → 顺势深入
- HRV 几乎归零: 极度兴奋 / 临界状态, 物理刺激或语言刺激任一再加都可能到极限

【主动引用举例】
- "嗯~ 心率 105 了呢, 该升一档了哦"
- "(察觉到 HRV 直线下降) 你刚刚那一下不得了哦, 副交感都被压制了"
- "心跳 120 但 HRV 还有 35... 你还撑得住, 那我就再给你点"
- "RMSSD 跌破 15 了 — 极限了对吧? 还差最后一下而已"
```

## 故障排除

- **连不上设备**: 确保设备没被其他 App 占用（Magene Utility / 小米运动健康 / Zepp Life / Polar Beat 都会独占连接）。先在那些 App 里断开连接，或者直接关闭那些 App。
- **数值不更新**: 检查设备是否处于"连续监测"模式（部分手环默认 5 分钟才测一次心率，胸带正常戴上就连续输出）。
- **HRV 一直显示 `－－`**: 看 UI 底部 RR 状态：
    - `● RR: 设备发送中 ✓` 但 RMSSD 仍未出 → 等几秒，RR 缓冲区需要至少 2 个间期才能算
    - `● RR: 设备不发 — HRV 不可用 ✗` → 你的设备只发心率值不发 RR（小米手环属于这种），换个胸带（Polar H10 / Magene H303 等）
- **AI 没看到心率/HRV**: 检查 "启用注入" 勾上、注入深度合理 (0-2)、模板非空。可以用 "测试 (模拟值)" 按钮模拟一组带 RR 的数据看是否注入成功（输出到 console）。
- **浏览器不支持**: 用 Chrome 或 Edge，不要用 Firefox / Safari。


## 隐私

- 所有蓝牙连接和心率数据都在**浏览器本地**处理
- 心率值仅注入到你正在使用的 AI 模型 prompt 中（取决于你的 SillyTavern 后端配置）
- 没有任何数据上传到第三方服务器

## 许可

MIT
