// Quick offline sanity test for the BLE HR Measurement parser.
// Mirrors the parseHRM logic in index.js. Not loaded by the extension.
//
// Run with:  node test-parse.mjs
//
// Test vectors are constructed per the Bluetooth SIG GATT spec for
// Heart Rate Measurement (UUID 0x2A37).

function parseHRM(dataView) {
    const flags = dataView.getUint8(0);
    const is16bit = (flags & 0x01) === 1;
    const sensorContact = (flags >> 1) & 0x03;
    const hasEnergy = (flags & 0x08) !== 0;
    const hasRR = (flags & 0x10) !== 0;

    let offset = 1;
    let hr;
    if (is16bit) {
        hr = dataView.getUint16(offset, true);
        offset += 2;
    } else {
        hr = dataView.getUint8(offset);
        offset += 1;
    }
    if (hasEnergy) offset += 2;

    const rrIntervalsMs = [];
    if (hasRR) {
        while (offset + 1 < dataView.byteLength) {
            const rrRaw = dataView.getUint16(offset, true);
            offset += 2;
            const rrMs = (rrRaw * 1000) / 1024;
            if (rrMs > 200 && rrMs < 2000) rrIntervalsMs.push(rrMs);
        }
    }
    return { hr, hasRR, rrIntervalsMs, sensorContact };
}

function makeDV(bytes) {
    return new DataView(new Uint8Array(bytes).buffer);
}

let pass = 0;
let fail = 0;
function assertEq(name, got, want, eps = 1e-6) {
    const ok = Math.abs(got - want) <= eps;
    if (ok) {
        pass++;
        console.log(`✓ ${name}: ${got}`);
    } else {
        fail++;
        console.log(`✗ ${name}: got=${got}, want=${want}`);
    }
}

// --- Test 1: small-band-style packet (no RR) ---
//   flags=0x00 (8-bit HR, no RR), HR=72
{
    const dv = makeDV([0x00, 0x48]);
    const r = parseHRM(dv);
    assertEq("test1.hr", r.hr, 72);
    assertEq("test1.hasRR", r.hasRR, false);
    assertEq("test1.rrCount", r.rrIntervalsMs.length, 0);
}

// --- Test 2: chest-strap-style packet with 2 RR intervals ---
//   flags=0x10 (8-bit HR, RR present), HR=68
//   RR raw values 880 and 870 (1/1024 sec)
//   Expected ms: 880*1000/1024 = 859.375; 870*1000/1024 = 849.609375
{
    const rr1 = 880;
    const rr2 = 870;
    const dv = makeDV([
        0x10,
        0x44,
        rr1 & 0xff, (rr1 >> 8) & 0xff,
        rr2 & 0xff, (rr2 >> 8) & 0xff,
    ]);
    const r = parseHRM(dv);
    assertEq("test2.hr", r.hr, 68);
    assertEq("test2.hasRR", r.hasRR, true);
    assertEq("test2.rrCount", r.rrIntervalsMs.length, 2);
    assertEq("test2.rr1_ms", r.rrIntervalsMs[0], (880 * 1000) / 1024, 1e-9);
    assertEq("test2.rr2_ms", r.rrIntervalsMs[1], (870 * 1000) / 1024, 1e-9);
}

// --- Test 3: 16-bit HR + Energy + RR ---
//   flags=0x19 (bit0=1 16-bit HR, bit3=1 energy, bit4=1 RR), HR=300, energy=0x0064, RR=900
{
    const dv = makeDV([
        0x19,
        300 & 0xff, (300 >> 8) & 0xff,
        0x64, 0x00,
        900 & 0xff, (900 >> 8) & 0xff,
    ]);
    const r = parseHRM(dv);
    assertEq("test3.hr", r.hr, 300);
    assertEq("test3.hasRR", r.hasRR, true);
    assertEq("test3.rrCount", r.rrIntervalsMs.length, 1);
    assertEq("test3.rr_ms", r.rrIntervalsMs[0], (900 * 1000) / 1024, 1e-9);
}

// --- Test 4: Magene H303-style realistic packet ---
//   flags=0x16 (8-bit HR, sensor contact ok=11, RR present)
//   = 0001 0110 = bit1+bit2+bit4 = 2+4+16 = 0x16
//   HR=72, RR=899 (~877.93ms ≈ 68bpm but realistic jitter not relevant here)
{
    const dv = makeDV([
        0x16,
        72,
        899 & 0xff, (899 >> 8) & 0xff,
    ]);
    const r = parseHRM(dv);
    assertEq("test4.hr", r.hr, 72);
    assertEq("test4.hasRR", r.hasRR, true);
    assertEq("test4.sensorContact", r.sensorContact, 0x03);
    assertEq("test4.rrCount", r.rrIntervalsMs.length, 1);
}

// --- RMSSD smoke test ---
function rmssd(rrs) {
    let sumSq = 0;
    for (let i = 1; i < rrs.length; i++) {
        const d = rrs[i] - rrs[i - 1];
        sumSq += d * d;
    }
    return Math.sqrt(sumSq / (rrs.length - 1));
}
{
    // identical RRs → RMSSD = 0
    assertEq("rmssd.const", rmssd([1000, 1000, 1000, 1000]), 0);
    // alternating ±50 → RMSSD = 100 (each diff is 100 in magnitude)
    assertEq("rmssd.alt", rmssd([950, 1050, 950, 1050]), 100);
}

// --- Dedup logic test (mirrors the cross-packet dedup in handleNotification) ---
//
// Simulates a Magene-H303-style 2 Hz BLE notification stream where the
// device re-broadcasts the most recent RR if no new beat happened since
// last notification. We expect the dedup logic to filter out re-broadcasts
// while keeping all real new beats.
function applyDedup(packets) {
    // Each packet: { ts: ms, rrs: [number, ...] }
    const buffer = []; // { ts, rr }
    let dupSkipped = 0;
    for (const p of packets) {
        for (let i = 0; i < p.rrs.length; i++) {
            const rr = p.rrs[i];
            const last = buffer[buffer.length - 1];
            const isFirstInPacket = i === 0;
            const isExactDup = last && Math.abs(last.rr - rr) < 0.5;
            const tooSoon = last && p.ts - last.ts < last.rr * 0.85;
            if (isFirstInPacket && isExactDup && tooSoon) {
                dupSkipped++;
                continue;
            }
            buffer.push({ ts: p.ts, rr });
        }
    }
    return { rrs: buffer.map((b) => b.rr), dupSkipped };
}

{
    // Scenario A: 2Hz notifications, device re-sends last RR every packet
    //   t=0    : RR=700  (real beat)
    //   t=500  : RR=700  (REBROADCAST — should drop)
    //   t=1000 : RR=720  (real new beat)
    //   t=1500 : RR=720  (REBROADCAST — should drop)
    //   t=2000 : RR=690  (real new beat)
    //   t=2500 : RR=690  (REBROADCAST — should drop)
    const out = applyDedup([
        { ts: 0,    rrs: [700] },
        { ts: 500,  rrs: [700] },
        { ts: 1000, rrs: [720] },
        { ts: 1500, rrs: [720] },
        { ts: 2000, rrs: [690] },
        { ts: 2500, rrs: [690] },
    ]);
    assertEq("dedup.A.kept", out.rrs.length, 3);
    assertEq("dedup.A.skipped", out.dupSkipped, 3);
    assertEq("dedup.A.rr0", out.rrs[0], 700);
    assertEq("dedup.A.rr1", out.rrs[1], 720);
    assertEq("dedup.A.rr2", out.rrs[2], 690);
    // RMSSD on deduped data: diffs = [20, 30] → sqrt((400+900)/2) = sqrt(650)
    assertEq("dedup.A.rmssd", rmssd(out.rrs), Math.sqrt(650), 1e-9);
}

{
    // Scenario B: legitimate consecutive identical RRs that arrive at full beat interval
    //   t=0    : RR=700
    //   t=700  : RR=700  (real new beat that happens to have same RR — KEEP)
    //   t=1400 : RR=700  (another real new beat, same RR — KEEP)
    const out = applyDedup([
        { ts: 0,    rrs: [700] },
        { ts: 700,  rrs: [700] },
        { ts: 1400, rrs: [700] },
    ]);
    // Edge case: 700 < 700*0.85 = 595? No, 700 > 595 so kept.
    assertEq("dedup.B.kept", out.rrs.length, 3);
    assertEq("dedup.B.skipped", out.dupSkipped, 0);
}

{
    // Scenario C: multi-RR packet (e.g. 1Hz notification with 2 beats in window)
    //   t=0    : RR=[700, 720]   (two real beats packed in one packet — KEEP both)
    //   t=1000 : RR=[690]        (next beat — KEEP)
    const out = applyDedup([
        { ts: 0,    rrs: [700, 720] },
        { ts: 1000, rrs: [690] },
    ]);
    assertEq("dedup.C.kept", out.rrs.length, 3);
    assertEq("dedup.C.skipped", out.dupSkipped, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
