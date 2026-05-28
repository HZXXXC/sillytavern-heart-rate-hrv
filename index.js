// SPDX-License-Identifier: MIT
// SillyTavern 心率监测扩展 (Web Bluetooth)
// 读取标准 BLE Heart Rate Profile, 注入心率到 AI 提示

import { extension_settings } from "../../../extensions.js";
import {
    saveSettingsDebounced,
    setExtensionPrompt,
    eventSource,
    event_types,
} from "../../../../script.js";

const $ = window.$;

const EXT_NAME = "heart-rate";
const PROMPT_KEY = "HR_LIVE";

const POSITION_IN_CHAT = 1;

const DEFAULTS = {
    enabled: true,
    autoConnect: false,
    deviceName: null,
    deviceId: null,
    injectionDepth: 0,
    injectionRole: 0,
    template:
        "[当前用户实时生理状态: 心率 {{hr}} bpm ({{state}}, {{trend}}) | HRV(RMSSD) {{rmssd}} ms ({{hrv_state}}) | 距上次更新 {{age}}s]",
    thresholds: {
        cold: 70,
        warm: 90,
        excited: 110,
        critical: 130,
    },
    labels: {
        cold: "冷静",
        warm: "进入状态",
        excited: "兴奋",
        critical: "临界",
        extreme: "极限",
    },
    // HRV(RMSSD) 个人差异巨大，下面是粗略默认值，建议你
    // 安静坐着时连接 1-2 分钟看一下基线，然后把 high 设到基线 70%、
    // low 设到基线 30%。
    hrvThresholds: {
        // RMSSD 的物理意义：值越低交感神经越激活（越紧张/兴奋）
        suppressed: 15,  // < 15 ms: 副交感几乎被压制 → 极度兴奋/应激
        low: 25,         // 15-25 ms: 明显紧张/兴奋
        mid: 45,         // 25-45 ms: 一般状态
        high: 70,        // 45-70 ms: 放松
        // > high: 深度放松
    },
    hrvLabels: {
        suppressed: "副交感压制",
        low: "兴奋/紧张",
        mid: "一般",
        high: "放松",
        veryHigh: "深度放松",
    },
    maxStaleSeconds: 30,
    historySize: 30,
    // RR 缓冲区窗口 (秒): 30s 适合实时 RMSSD
    rrWindowSeconds: 30,
    // 注入心率 + HRV (默认开)；关闭后只注入心率
    injectHRV: true,
    // 浮动窗 (常驻角落, 不依赖 ST 顶栏)
    floatingEnabled: true,
    floatingX: null, // null = 使用默认位置
    floatingY: null,
    floatingCollapsed: false,
};

const state = {
    device: null,
    server: null,
    characteristic: null,
    currentHR: null,
    lastUpdate: null,
    history: [],
    connected: false,
    // RR 间期相关 ---------------
    // rrBuffer: [{ ts: Date.now(), rr: 870 }, ...] (rr 单位 ms)
    rrBuffer: [],
    // 设备是否在 BLE 报文 flag bit 4 里真的塞了 RR
    // 第一次收到通知后被设置, 用来在 UI 提示 "你这个设备不发 RR"
    deviceSendsRR: null, // null = 还没判断, true/false = 已判断
    // 最近一次 HRV 计算结果, 仅用于 UI 显示
    rmssd: null,
    sdnn: null,
    meanRR: null,
    pnn50: null,
    rrCount: 0,
    maxDiff: null, // 窗口内相邻 RR 最大差值 (ms), 用来直观看出抖动幅度
    dupSkipped: 0, // 累计跳过的跨包重发次数 (诊断用)
    // 测试模式: 在此时间戳之前, 真实通知到来时不写入 buffer.
    // 用于让"测试(模拟值)"按钮能给出纯净结果, 而不会被实时数据稀释.
    testFreezeUntil: 0,
};

function settings() {
    if (!extension_settings[EXT_NAME]) {
        extension_settings[EXT_NAME] = structuredClone(DEFAULTS);
    }
    // shallow merge any new defaults
    const s = extension_settings[EXT_NAME];
    for (const k of Object.keys(DEFAULTS)) {
        if (s[k] === undefined) s[k] = structuredClone(DEFAULTS[k]);
    }
    return s;
}

function getStateLabel(hr) {
    const s = settings();
    const t = s.thresholds;
    const l = s.labels;
    if (hr == null) return "未知";
    if (hr < t.cold) return l.cold;
    if (hr < t.warm) return l.warm;
    if (hr < t.excited) return l.excited;
    if (hr < t.critical) return l.critical;
    return l.extreme;
}

function getTrend() {
    if (state.history.length < 4) return "稳定";
    const recent = state.history.slice(-6);
    const first = recent[0].hr;
    const last = recent[recent.length - 1].hr;
    const diff = last - first;
    if (diff > 10) return "快速上升↑↑";
    if (diff > 4) return "上升↑";
    if (diff < -10) return "快速下降↓↓";
    if (diff < -4) return "下降↓";
    return "稳定→";
}

function ageSeconds() {
    if (!state.lastUpdate) return 999;
    return Math.floor((Date.now() - state.lastUpdate) / 1000);
}

function parseHRM(value) {
    // BLE Heart Rate Measurement characteristic format (0x2A37)
    // 完整规范见 Bluetooth SIG GATT Spec - Heart Rate Service.
    // Layout:
    //   byte 0: flags
    //     bit 0: HR value format (0 = uint8, 1 = uint16)
    //     bit 1-2: Sensor Contact Status
    //     bit 3: Energy Expended Present (uint16, 跳 2 字节)
    //     bit 4: RR-Interval Present (uint16 数组, 单位 1/1024 秒)
    //   byte 1..: HR value (1 或 2 字节)
    //   后面可能跟 Energy Expended (2 字节)
    //   再后面可能跟若干个 RR (每个 2 字节, little-endian)
    const flags = value.getUint8(0);
    const is16bit = (flags & 0x01) === 1;
    const sensorContact = (flags >> 1) & 0x03; // 0/1=不支持, 2=未接触, 3=已接触
    const hasEnergy = (flags & 0x08) !== 0;
    const hasRR = (flags & 0x10) !== 0;

    let offset = 1;
    let hr;
    if (is16bit) {
        hr = value.getUint16(offset, true);
        offset += 2;
    } else {
        hr = value.getUint8(offset);
        offset += 1;
    }

    if (hasEnergy) {
        // Energy Expended (kJ), 当前用不到, 跳过
        offset += 2;
    }

    const rrIntervalsMs = [];
    if (hasRR) {
        // 每个 RR 间期是 uint16 little-endian, 单位 1/1024 秒
        // 转 ms: rr_raw * 1000 / 1024
        while (offset + 1 < value.byteLength) {
            const rrRaw = value.getUint16(offset, true);
            offset += 2;
            const rrMs = (rrRaw * 1000) / 1024;
            // 合理性过滤: 200ms (300bpm) - 2000ms (30bpm)
            if (rrMs > 200 && rrMs < 2000) {
                rrIntervalsMs.push(rrMs);
            }
        }
    }

    return { hr, hasRR, rrIntervalsMs, sensorContact };
}

function pruneRRBuffer() {
    const s = settings();
    const cutoff = Date.now() - s.rrWindowSeconds * 1000;
    while (state.rrBuffer.length && state.rrBuffer[0].ts < cutoff) {
        state.rrBuffer.shift();
    }
}

function recomputeHRV() {
    pruneRRBuffer();
    const rrs = state.rrBuffer.map((x) => x.rr);
    state.rrCount = rrs.length;
    if (rrs.length < 2) {
        state.rmssd = null;
        state.sdnn = null;
        state.meanRR = null;
        state.pnn50 = null;
        return;
    }
    // RMSSD: 相邻 RR 差值平方均值的开方
    let sumSqDiff = 0;
    let nn50 = 0;
    let maxAbsDiff = 0;
    for (let i = 1; i < rrs.length; i++) {
        const d = rrs[i] - rrs[i - 1];
        const ad = Math.abs(d);
        sumSqDiff += d * d;
        if (ad > 50) nn50++;
        if (ad > maxAbsDiff) maxAbsDiff = ad;
    }
    state.rmssd = Math.sqrt(sumSqDiff / (rrs.length - 1));
    state.pnn50 = (nn50 / (rrs.length - 1)) * 100;
    state.maxDiff = maxAbsDiff;
    // Mean RR + SDNN
    const mean = rrs.reduce((a, b) => a + b, 0) / rrs.length;
    state.meanRR = mean;
    let sumSq = 0;
    for (const r of rrs) sumSq += (r - mean) * (r - mean);
    state.sdnn = Math.sqrt(sumSq / rrs.length);
}

function getHRVStateLabel(rmssd) {
    if (rmssd == null) return "未知";
    const s = settings();
    const t = s.hrvThresholds;
    const l = s.hrvLabels;
    if (rmssd < t.suppressed) return l.suppressed;
    if (rmssd < t.low) return l.low;
    if (rmssd < t.mid) return l.mid;
    if (rmssd < t.high) return l.high;
    return l.veryHigh;
}

function handleNotification(event) {
    const value = event.target.value;
    const parsed = parseHRM(value);
    const { hr, hasRR, rrIntervalsMs } = parsed;
    if (hr <= 0 || hr > 250) return; // sanity check

    const now = Date.now();
    state.currentHR = hr;
    state.lastUpdate = now;
    state.history.push({ ts: now, hr });
    if (state.history.length > settings().historySize) state.history.shift();

    // 第一次收到通知就锁定设备是否发 RR
    if (state.deviceSendsRR === null) {
        state.deviceSendsRR = hasRR;
        if (!hasRR) {
            console.warn(
                "[HR] 该设备未在 BLE 报文中发送 RR 间期 (flag bit 4 = 0). " +
                "无法计算 HRV. 小米手环等设备属于这种情况, " +
                "Polar / Magene H303 / Garmin 胸带正常应该都发 RR."
            );
        } else {
            console.log("[HR] 设备发送 RR 间期, HRV 可用 ✓");
        }
    } else if (hasRR && state.deviceSendsRR === false) {
        // 之前判断错了 (有些设备会跳着发), 修正
        state.deviceSendsRR = true;
    }

    // 测试冻结期: 测试按钮会注入模拟数据并冻结真实 RR 写入 N 秒,
    // 让用户能看到纯净的模拟结果而不被实时数据稀释.
    if (now < state.testFreezeUntil) {
        // 仍然更新 UI 上的当前 HR 显示, 但不污染 RR 缓冲区
        updateUI();
        return;
    }

    if (rrIntervalsMs.length > 0) {
        // 去重：部分 BLE 心率设备 (例: Magene H303) 通知周期是固定的 ~500ms,
        // 当心率 < 120 bpm 时, 一个通知周期内可能不会有新的心跳, 设备会
        // 把"上一拍的 RR"原样重发. 这些复制品会让相邻差为 0, 把 RMSSD 拉到地板,
        // pNN50 永远归零, 导致 HRV 全错.
        //
        // 判定: 当前通知只有 1 个 RR && 它跟最后一条 buffer 完全相同
        //       && 时间间隔短于"上一拍 RR × 0.85" → 不可能是真新拍, 当作重发丢弃
        let pushedAny = false;
        for (let i = 0; i < rrIntervalsMs.length; i++) {
            const rr = rrIntervalsMs[i];
            const last = state.rrBuffer[state.rrBuffer.length - 1];
            const isFirstInPacket = i === 0;
            const isExactDup =
                last && Math.abs(last.rr - rr) < 0.5;
            const tooSoon =
                last && now - last.ts < last.rr * 0.85;
            if (isFirstInPacket && isExactDup && tooSoon) {
                state.dupSkipped++;
                continue;
            }
            state.rrBuffer.push({ ts: now, rr });
            pushedAny = true;
        }
        if (pushedAny) recomputeHRV();
    }

    updateUI();
    updateInjection();
}

function onDisconnect() {
    state.connected = false;
    state.characteristic = null;
    state.server = null;
    updateUI();
    updateInjection();
    console.log("[HR] Device disconnected");
}

async function connect() {
    if (!navigator.bluetooth) {
        alert("浏览器不支持 Web Bluetooth API。请使用 Chrome / Edge。");
        return;
    }
    try {
        $("#hr-connect-btn").prop("disabled", true).text("连接中…");
        const device = await navigator.bluetooth.requestDevice({
            filters: [{ services: ["heart_rate"] }],
            optionalServices: ["battery_service", "device_information"],
        });

        state.device = device;
        device.addEventListener("gattserverdisconnected", onDisconnect);

        const server = await device.gatt.connect();
        state.server = server;

        const service = await server.getPrimaryService("heart_rate");
        const ch = await service.getCharacteristic("heart_rate_measurement");
        state.characteristic = ch;

        await ch.startNotifications();
        ch.addEventListener("characteristicvaluechanged", handleNotification);

        const s = settings();
        s.deviceName = device.name || "(未命名设备)";
        s.deviceId = device.id;
        saveSettingsDebounced();

        state.connected = true;
        updateUI();
        console.log("[HR] Connected to", device.name);
    } catch (e) {
        console.error("[HR] Connect failed", e);
        alert("心率设备连接失败: " + e.message);
    } finally {
        $("#hr-connect-btn").prop("disabled", false);
        updateButtonText();
    }
}

async function disconnect() {
    try {
        if (state.characteristic) {
            try {
                await state.characteristic.stopNotifications();
            } catch (_) {}
            state.characteristic.removeEventListener(
                "characteristicvaluechanged",
                handleNotification,
            );
        }
        if (state.server && state.server.connected) {
            state.server.disconnect();
        }
    } catch (e) {
        console.warn("[HR] Disconnect error", e);
    }
    state.connected = false;
    state.characteristic = null;
    state.server = null;
    state.device = null;
    state.currentHR = null;
    state.rrBuffer = [];
    state.rmssd = null;
    state.sdnn = null;
    state.meanRR = null;
    state.pnn50 = null;
    state.rrCount = 0;
    state.maxDiff = null;
    state.dupSkipped = 0;
    state.testFreezeUntil = 0;
    state.deviceSendsRR = null;
    updateUI();
    updateInjection();
    updateButtonText();
}

function updateButtonText() {
    if (state.connected) {
        $("#hr-connect-btn").text("断开连接");
    } else {
        $("#hr-connect-btn").text("连接心率设备");
    }
}

function updateUI() {
    updateFloatingUI();
    const display = $("#hr-display");
    const detail = $("#hr-detail");
    const hrvDisplay = $("#hrv-display");
    const hrvDetail = $("#hrv-detail");
    const rrStatus = $("#hr-rr-status");
    const stale = ageSeconds() > settings().maxStaleSeconds;

    if (state.currentHR == null) {
        display.text("－－").css("color", "var(--SmartThemeBodyColor)");
        detail.text(state.connected ? "等待数据…" : "未连接");
    } else {
        const label = getStateLabel(state.currentHR);
        const color = colorForHR(state.currentHR);
        display
            .text(`${state.currentHR}`)
            .css("color", stale ? "gray" : color);
        detail.text(
            `${stale ? "(过时) " : ""}${label} · 趋势 ${getTrend()} · ${ageSeconds()}s 前`,
        );
    }

    // HRV 显示
    if (state.rmssd == null) {
        hrvDisplay.text("－－").css("color", "var(--SmartThemeBodyColor)");
        if (state.deviceSendsRR === false) {
            hrvDetail
                .text("此设备不发送 RR — 无法计算 HRV")
                .css("color", "#f85");
        } else if (state.deviceSendsRR === true) {
            hrvDetail
                .text(`收集中… (RR 缓冲区: ${state.rrCount}/2+)`)
                .css("color", "");
        } else {
            hrvDetail.text(state.connected ? "等待 RR 数据…" : "—").css("color", "");
        }
    } else {
        const hrvLabel = getHRVStateLabel(state.rmssd);
        hrvDisplay
            .text(state.rmssd.toFixed(1))
            .css("color", colorForRMSSD(state.rmssd));
        const meanBpm = state.meanRR ? (60000 / state.meanRR).toFixed(1) : "?";
        const dupNote =
            state.dupSkipped > 0 ? ` · 去重 ${state.dupSkipped}` : "";
        hrvDetail
            .text(
                `${hrvLabel} · pNN50 ${state.pnn50.toFixed(1)}% · SDNN ${state.sdnn.toFixed(1)}ms · maxΔ ${state.maxDiff.toFixed(0)}ms · n=${state.rrCount} (≈${meanBpm}bpm)${dupNote}`,
            )
            .css("color", "");
    }

    // RR 状态指示器
    if (!state.connected) {
        rrStatus.text("").css("color", "");
    } else if (state.deviceSendsRR === null) {
        rrStatus.text("● RR: 检测中").css("color", "#888");
    } else if (state.deviceSendsRR) {
        rrStatus.text("● RR: 设备发送中 ✓").css("color", "#5fa");
    } else {
        rrStatus
            .text("● RR: 设备不发 — HRV 不可用 ✗")
            .css("color", "#f85");
    }
}

function colorForHR(hr) {
    if (hr == null) return "var(--SmartThemeBodyColor)";
    const s = settings();
    const t = s.thresholds;
    if (hr < t.cold) return "#5fa";
    if (hr < t.warm) return "#5cf";
    if (hr < t.excited) return "#fc5";
    if (hr < t.critical) return "#f85";
    return "#f44";
}

function colorForRMSSD(rmssd) {
    if (rmssd == null) return "var(--SmartThemeBodyColor)";
    const s = settings();
    const t = s.hrvThresholds;
    // HRV 颜色: 越低越红 (交感激活), 越高越绿 (副交感)
    if (rmssd < t.suppressed) return "#f44";
    if (rmssd < t.low) return "#f85";
    if (rmssd < t.mid) return "#fc5";
    if (rmssd < t.high) return "#5cf";
    return "#5fa";
}

function renderTemplate(tpl) {
    if (!tpl) return "";
    const s = settings();
    const showHRV = s.injectHRV && state.rmssd != null;
    const rmssdStr = showHRV ? state.rmssd.toFixed(1) : "未知";
    const sdnnStr = showHRV ? state.sdnn.toFixed(1) : "未知";
    const pnn50Str = showHRV ? state.pnn50.toFixed(1) : "未知";
    const hrvStateStr = showHRV ? getHRVStateLabel(state.rmssd) : "未知";
    return tpl
        .replaceAll("{{hr}}", state.currentHR != null ? state.currentHR : "未知")
        .replaceAll("{{state}}", getStateLabel(state.currentHR))
        .replaceAll("{{trend}}", getTrend())
        .replaceAll("{{age}}", ageSeconds())
        .replaceAll("{{rmssd}}", rmssdStr)
        .replaceAll("{{sdnn}}", sdnnStr)
        .replaceAll("{{pnn50}}", pnn50Str)
        .replaceAll("{{hrv_state}}", hrvStateStr);
}

function updateInjection() {
    const s = settings();
    if (!s.enabled || state.currentHR == null) {
        setExtensionPrompt(PROMPT_KEY, "", POSITION_IN_CHAT, 0);
        return;
    }
    if (ageSeconds() > s.maxStaleSeconds) {
        setExtensionPrompt(PROMPT_KEY, "", POSITION_IN_CHAT, 0);
        return;
    }
    const text = renderTemplate(s.template);
    // role 0 = system, depth from settings
    setExtensionPrompt(PROMPT_KEY, text, POSITION_IN_CHAT, s.injectionDepth, false, s.injectionRole);
}

// =================== 浮动窗 ===================
//
// 在 ST 顶栏不可见的页面 (欢迎页 / 角色管理 / 系统设置) 也能看到
// 心率 + HRV. 可拖拽、可折叠. 位置保存到 settings.
//
function buildFloatingWidget() {
    const html = `
<div id="hr-floating-widget" class="hr-float" data-collapsed="false">
  <div class="hr-float-grip">💗</div>
  <div class="hr-float-body">
    <div class="hr-float-row">
      <span class="hr-float-num" id="hr-float-hr">－－</span>
      <span class="hr-float-unit">bpm</span>
    </div>
    <div class="hr-float-row">
      <span class="hr-float-num" id="hr-float-rmssd">－－</span>
      <span class="hr-float-unit">ms</span>
    </div>
    <div class="hr-float-detail" id="hr-float-detail">未连接</div>
  </div>
  <div class="hr-float-actions">
    <span class="hr-float-btn" id="hr-float-collapse" title="折叠">－</span>
    <span class="hr-float-btn" id="hr-float-hide" title="隐藏 (可在扩展设置里重新打开)">×</span>
  </div>
</div>
    `;
    return html;
}

function applyFloatingPosition() {
    const s = settings();
    const $w = $("#hr-floating-widget");
    if (!$w.length) return;
    if (s.floatingX != null && s.floatingY != null) {
        // 边界保护, 防止保存的坐标在小屏幕上飘到屏幕外
        const maxX = Math.max(0, window.innerWidth - 60);
        const maxY = Math.max(0, window.innerHeight - 40);
        const x = Math.max(0, Math.min(s.floatingX, maxX));
        const y = Math.max(0, Math.min(s.floatingY, maxY));
        $w.css({
            left: x + "px",
            top: y + "px",
            right: "auto",
            bottom: "auto",
        });
    }
    $w.attr("data-collapsed", s.floatingCollapsed ? "true" : "false");
    $w.toggle(!!s.floatingEnabled);
}

function bindFloatingDrag() {
    const $w = $("#hr-floating-widget");
    const $grip = $("#hr-floating-widget .hr-float-grip");
    let dragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    function startDrag(clientX, clientY) {
        dragging = true;
        const rect = $w[0].getBoundingClientRect();
        dragOffsetX = clientX - rect.left;
        dragOffsetY = clientY - rect.top;
        $w.addClass("dragging");
    }
    function moveDrag(clientX, clientY) {
        if (!dragging) return;
        const x = Math.max(0, Math.min(clientX - dragOffsetX, window.innerWidth - $w.outerWidth()));
        const y = Math.max(0, Math.min(clientY - dragOffsetY, window.innerHeight - $w.outerHeight()));
        $w.css({ left: x + "px", top: y + "px", right: "auto", bottom: "auto" });
    }
    function endDrag() {
        if (!dragging) return;
        dragging = false;
        $w.removeClass("dragging");
        const s = settings();
        const rect = $w[0].getBoundingClientRect();
        s.floatingX = Math.round(rect.left);
        s.floatingY = Math.round(rect.top);
        saveSettingsDebounced();
    }

    $grip.on("mousedown", (e) => {
        e.preventDefault();
        startDrag(e.clientX, e.clientY);
    });
    $(document).on("mousemove.hrfloat", (e) => moveDrag(e.clientX, e.clientY));
    $(document).on("mouseup.hrfloat", endDrag);

    // Touch
    $grip.on("touchstart", (e) => {
        const t = e.originalEvent.touches[0];
        startDrag(t.clientX, t.clientY);
    });
    $(document).on("touchmove.hrfloat", (e) => {
        if (!dragging) return;
        const t = e.originalEvent.touches[0];
        moveDrag(t.clientX, t.clientY);
        e.preventDefault();
    });
    $(document).on("touchend.hrfloat", endDrag);
}

function bindFloatingActions() {
    $("#hr-float-collapse").on("click", function (e) {
        e.stopPropagation();
        const s = settings();
        s.floatingCollapsed = !s.floatingCollapsed;
        saveSettingsDebounced();
        applyFloatingPosition();
        // 同步到设置面板的折叠 checkbox
        $("#hr-float-collapsed").prop("checked", s.floatingCollapsed);
    });
    $("#hr-float-hide").on("click", function (e) {
        e.stopPropagation();
        const s = settings();
        s.floatingEnabled = false;
        saveSettingsDebounced();
        applyFloatingPosition();
        $("#hr-float-enabled").prop("checked", false);
    });
}

function updateFloatingUI() {
    const $w = $("#hr-floating-widget");
    if (!$w.length) return;
    const s = settings();
    if (!s.floatingEnabled) return;

    const $hr = $("#hr-float-hr");
    const $rmssd = $("#hr-float-rmssd");
    const $detail = $("#hr-float-detail");
    const stale = ageSeconds() > s.maxStaleSeconds;

    if (state.currentHR == null) {
        $hr.text("－－").css("color", "var(--SmartThemeBodyColor, #fff)");
    } else {
        $hr.text(state.currentHR).css(
            "color",
            stale ? "gray" : colorForHR(state.currentHR),
        );
    }
    if (state.rmssd == null) {
        $rmssd
            .text("－－")
            .css("color", "var(--SmartThemeBodyColor, #fff)");
    } else {
        $rmssd
            .text(state.rmssd.toFixed(1))
            .css("color", colorForRMSSD(state.rmssd));
    }

    let detailText;
    if (!state.connected) {
        detailText = "未连接";
    } else if (state.deviceSendsRR === false) {
        detailText = "心率已连接 · RR 不可用";
    } else if (state.currentHR == null) {
        detailText = "等待数据…";
    } else {
        const hrLabel = getStateLabel(state.currentHR);
        const hrvLabel =
            state.rmssd != null ? getHRVStateLabel(state.rmssd) : "—";
        detailText = `${hrLabel} · ${hrvLabel}`;
        if (stale) detailText = "(过时) " + detailText;
    }
    $detail.text(detailText);
}

// Periodic UI refresh (every 1s) so the "age" updates visually
setInterval(updateUI, 1000);

// Refresh injection right before generation
function onGenerationStarted() {
    updateInjection();
}

function buildPanel() {
    const html = `
<div id="hr-extension" class="heart-rate-extension">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>💗 心率监测 (Heart Rate)</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">

      <div id="hr-display-box">
        <div class="hr-twocol">
          <div class="hr-col">
            <div id="hr-display">－－</div>
            <div id="hr-unit">bpm</div>
            <div id="hr-detail">未连接</div>
          </div>
          <div class="hr-col">
            <div id="hrv-display">－－</div>
            <div id="hrv-unit">RMSSD ms</div>
            <div id="hrv-detail">—</div>
          </div>
        </div>
        <div id="hr-rr-status"></div>
      </div>

      <div class="hr-btn-row">
        <input id="hr-connect-btn" class="menu_button" type="button" value="连接心率设备" />
        <input id="hr-test-btn" class="menu_button" type="button" value="测试 (模拟值)" title="模拟心率 + 一组 RR 数据, 用来检查 HRV 计算与注入是否生效" />
      </div>

      <hr />

      <label class="checkbox_label" for="hr-enabled">
        <input id="hr-enabled" type="checkbox" />
        <span>启用注入 (把心率/HRV 塞进 AI 提示)</span>
      </label>

      <label class="checkbox_label" for="hr-inject-hrv">
        <input id="hr-inject-hrv" type="checkbox" />
        <span>同时注入 HRV (RMSSD) — 设备不发 RR 则自动跳过</span>
      </label>

      <label class="checkbox_label" for="hr-float-enabled">
        <input id="hr-float-enabled" type="checkbox" />
        <span>显示浮动窗 (常驻角落, 可拖拽)</span>
      </label>
      <label class="checkbox_label" for="hr-float-collapsed">
        <input id="hr-float-collapsed" type="checkbox" />
        <span>浮动窗折叠 (只显示数字)</span>
      </label>
      <input id="hr-float-reset-btn" class="menu_button" type="button" value="重置浮动窗位置" />

      <label for="hr-depth">注入深度 (距离最后一条消息的轮数, 0 = 紧贴最后)</label>
      <input id="hr-depth" type="number" min="0" max="20" step="1" class="text_pole" />

      <label for="hr-role">注入角色</label>
      <select id="hr-role" class="text_pole">
        <option value="0">System</option>
        <option value="1">User</option>
        <option value="2">Assistant</option>
      </select>

      <label for="hr-template">注入模板</label>
      <div class="hr-foot" style="opacity:.7;margin:2px 0 4px 0;">
        变量: {{hr}} {{state}} {{trend}} {{age}} {{rmssd}} {{sdnn}} {{pnn50}} {{hrv_state}}
      </div>
      <textarea id="hr-template" class="text_pole" rows="2"></textarea>

      <label for="hr-stale">过时丢弃秒数 (超过这个秒数不更新就不再注入)</label>
      <input id="hr-stale" type="number" min="5" max="600" step="5" class="text_pole" />

      <hr />

      <details>
        <summary>心率状态阈值 (bpm)</summary>
        <div class="hr-grid">
          <label>冷静 <</label><input id="hr-t-cold" type="number" class="text_pole" />
          <label>进入状态 <</label><input id="hr-t-warm" type="number" class="text_pole" />
          <label>兴奋 <</label><input id="hr-t-excited" type="number" class="text_pole" />
          <label>临界 <</label><input id="hr-t-critical" type="number" class="text_pole" />
        </div>
      </details>

      <details>
        <summary>心率状态标签</summary>
        <div class="hr-grid">
          <label>冷静</label><input id="hr-l-cold" type="text" class="text_pole" />
          <label>进入状态</label><input id="hr-l-warm" type="text" class="text_pole" />
          <label>兴奋</label><input id="hr-l-excited" type="text" class="text_pole" />
          <label>临界</label><input id="hr-l-critical" type="text" class="text_pole" />
          <label>极限</label><input id="hr-l-extreme" type="text" class="text_pole" />
        </div>
      </details>

      <details>
        <summary>HRV (RMSSD) 阈值 (ms) — 个人差异大, 建议安静测一两分钟看基线</summary>
        <div class="hr-grid">
          <label>副交感压制 <</label><input id="hrv-t-suppressed" type="number" class="text_pole" />
          <label>兴奋/紧张 <</label><input id="hrv-t-low" type="number" class="text_pole" />
          <label>一般 <</label><input id="hrv-t-mid" type="number" class="text_pole" />
          <label>放松 <</label><input id="hrv-t-high" type="number" class="text_pole" />
        </div>
      </details>

      <details>
        <summary>HRV 状态标签</summary>
        <div class="hr-grid">
          <label>副交感压制</label><input id="hrv-l-suppressed" type="text" class="text_pole" />
          <label>兴奋/紧张</label><input id="hrv-l-low" type="text" class="text_pole" />
          <label>一般</label><input id="hrv-l-mid" type="text" class="text_pole" />
          <label>放松</label><input id="hrv-l-high" type="text" class="text_pole" />
          <label>深度放松</label><input id="hrv-l-veryHigh" type="text" class="text_pole" />
        </div>
      </details>

      <label for="hr-rr-window">RR 滑动窗口 (秒) — RMSSD 一般 30s 即可</label>
      <input id="hr-rr-window" type="number" min="10" max="300" step="5" class="text_pole" />

      <div class="hr-foot">
        要求设备支持标准 BLE Heart Rate Profile (0x180D / 0x2A37).<br>
        HRV (RMSSD) 需要设备在 HR Measurement 报文 flag bit 4 中发送 RR 间期 — 
        Polar、Magene H303/H603、Garmin、Wahoo、Coros 这类胸带都正常发；小米手环不发 (要走私有协议).<br>
        Chrome/Edge 浏览器 + HTTPS 或 localhost.
      </div>

    </div>
  </div>
</div>
`;
    return html;
}

function loadSettingsToUI() {
    const s = settings();
    $("#hr-enabled").prop("checked", s.enabled);
    $("#hr-inject-hrv").prop("checked", s.injectHRV);
    $("#hr-float-enabled").prop("checked", s.floatingEnabled);
    $("#hr-float-collapsed").prop("checked", s.floatingCollapsed);
    $("#hr-depth").val(s.injectionDepth);
    $("#hr-role").val(s.injectionRole);
    $("#hr-template").val(s.template);
    $("#hr-stale").val(s.maxStaleSeconds);
    $("#hr-rr-window").val(s.rrWindowSeconds);
    $("#hr-t-cold").val(s.thresholds.cold);
    $("#hr-t-warm").val(s.thresholds.warm);
    $("#hr-t-excited").val(s.thresholds.excited);
    $("#hr-t-critical").val(s.thresholds.critical);
    $("#hr-l-cold").val(s.labels.cold);
    $("#hr-l-warm").val(s.labels.warm);
    $("#hr-l-excited").val(s.labels.excited);
    $("#hr-l-critical").val(s.labels.critical);
    $("#hr-l-extreme").val(s.labels.extreme);
    $("#hrv-t-suppressed").val(s.hrvThresholds.suppressed);
    $("#hrv-t-low").val(s.hrvThresholds.low);
    $("#hrv-t-mid").val(s.hrvThresholds.mid);
    $("#hrv-t-high").val(s.hrvThresholds.high);
    $("#hrv-l-suppressed").val(s.hrvLabels.suppressed);
    $("#hrv-l-low").val(s.hrvLabels.low);
    $("#hrv-l-mid").val(s.hrvLabels.mid);
    $("#hrv-l-high").val(s.hrvLabels.high);
    $("#hrv-l-veryHigh").val(s.hrvLabels.veryHigh);
}

function bindEvents() {
    const s = settings();
    $("#hr-connect-btn").on("click", () => {
        if (state.connected) disconnect();
        else connect();
    });
    $("#hr-test-btn").on("click", () => {
        // 测试: 注入一组带 ±50ms 抖动的假 RR, 期望 RMSSD≈40 / pNN50≈50% / maxΔ≈100ms.
        // 为了得到纯净结果, 同时清空已有缓冲区, 并在接下来的 8 秒
        // 内忽略真实设备通知 (UI 上的 HR 数字仍会跟随实时值更新).
        const FREEZE_MS = 8000;
        const fake = Math.floor(70 + Math.random() * 60);
        const now = Date.now();
        const baseRR = 60000 / fake;

        state.currentHR = fake;
        state.lastUpdate = now;
        state.history = [{ ts: now, hr: fake }];
        state.rrBuffer = [];
        state.dupSkipped = 0;
        state.deviceSendsRR = true;
        state.testFreezeUntil = now + FREEZE_MS;

        for (let i = 0; i < 30; i++) {
            const jitter = (Math.random() - 0.5) * 100;
            state.rrBuffer.push({
                ts: now - (30 - i) * 1000,
                rr: baseRR + jitter,
            });
        }
        recomputeHRV();
        updateUI();
        updateInjection();
        console.log(
            `[HR] Test injected ${fake} bpm with 30 fake RRs; ` +
                `RMSSD=${state.rmssd?.toFixed(1)}ms, ` +
                `pNN50=${state.pnn50?.toFixed(1)}%, ` +
                `maxΔ=${state.maxDiff?.toFixed(0)}ms. ` +
                `Real RR notifications frozen for ${FREEZE_MS}ms.`,
        );
    });
    $("#hr-enabled").on("change", function () {
        s.enabled = this.checked;
        saveSettingsDebounced();
        updateInjection();
    });
    $("#hr-inject-hrv").on("change", function () {
        s.injectHRV = this.checked;
        saveSettingsDebounced();
        updateInjection();
    });
    $("#hr-float-enabled").on("change", function () {
        s.floatingEnabled = this.checked;
        saveSettingsDebounced();
        applyFloatingPosition();
    });
    $("#hr-float-collapsed").on("change", function () {
        s.floatingCollapsed = this.checked;
        saveSettingsDebounced();
        applyFloatingPosition();
    });
    $("#hr-float-reset-btn").on("click", function () {
        s.floatingX = null;
        s.floatingY = null;
        s.floatingEnabled = true;
        s.floatingCollapsed = false;
        saveSettingsDebounced();
        $("#hr-float-enabled").prop("checked", true);
        $("#hr-float-collapsed").prop("checked", false);
        $("#hr-floating-widget").css({
            top: "",
            left: "",
            right: "",
            bottom: "",
        });
        applyFloatingPosition();
    });
    $("#hr-depth").on("change", function () {
        s.injectionDepth = parseInt(this.value) || 0;
        saveSettingsDebounced();
        updateInjection();
    });
    $("#hr-role").on("change", function () {
        s.injectionRole = parseInt(this.value) || 0;
        saveSettingsDebounced();
        updateInjection();
    });
    $("#hr-template").on("change", function () {
        s.template = this.value;
        saveSettingsDebounced();
        updateInjection();
    });
    $("#hr-stale").on("change", function () {
        s.maxStaleSeconds = parseInt(this.value) || 30;
        saveSettingsDebounced();
        updateInjection();
    });
    $("#hr-rr-window").on("change", function () {
        const v = parseInt(this.value);
        s.rrWindowSeconds = isNaN(v) ? 30 : Math.max(10, Math.min(300, v));
        saveSettingsDebounced();
        recomputeHRV();
        updateInjection();
        updateUI();
    });
    for (const k of ["cold", "warm", "excited", "critical"]) {
        $(`#hr-t-${k}`).on("change", function () {
            s.thresholds[k] = parseInt(this.value);
            saveSettingsDebounced();
            updateInjection();
            updateUI();
        });
    }
    for (const k of ["cold", "warm", "excited", "critical", "extreme"]) {
        $(`#hr-l-${k}`).on("change", function () {
            s.labels[k] = this.value;
            saveSettingsDebounced();
            updateInjection();
            updateUI();
        });
    }
    for (const k of ["suppressed", "low", "mid", "high"]) {
        $(`#hrv-t-${k}`).on("change", function () {
            const v = parseInt(this.value);
            if (!isNaN(v)) {
                s.hrvThresholds[k] = v;
                saveSettingsDebounced();
                updateInjection();
                updateUI();
            }
        });
    }
    for (const k of ["suppressed", "low", "mid", "high", "veryHigh"]) {
        $(`#hrv-l-${k}`).on("change", function () {
            s.hrvLabels[k] = this.value;
            saveSettingsDebounced();
            updateInjection();
            updateUI();
        });
    }
}

jQuery(async () => {
    try {
        $("#extensions_settings").append(buildPanel());
        $("body").append(buildFloatingWidget());
        applyFloatingPosition();
        bindFloatingDrag();
        bindFloatingActions();
        loadSettingsToUI();
        bindEvents();
        updateButtonText();
        updateUI();
        eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
        console.log("[HR] Heart Rate extension loaded (with floating widget)");
    } catch (e) {
        console.error("[HR] init failed", e);
    }
});
