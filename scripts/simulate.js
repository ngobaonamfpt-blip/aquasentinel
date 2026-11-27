// Script giả lập thiết bị đai ngực ESP32 gửi dữ liệu Telemetry lên AquaSentinel Server (v2.5)
// Hỗ trợ điều khiển tương tác qua bàn phím: [n] Bình thường | [s] SOS | [d] Bất động | [w] Vùng vẫy | [q] Thoát
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

const URL_BASE = (args.url || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const DEVICE_ID = args.device || 'AQUA-11';
const ZONE = (args.zone || 'THCS').toUpperCase(); // TH | THCS | THPT
const API_KEY = args.key || process.env.API_KEY || '';
const INTERVAL = Number(args.interval) || 1; // gửi mỗi 1 giây giống ESP32 thật

let mode = args.mode || 'normal'; // 'normal' | 'sos' | 'drown' | 'struggle'
let stillDuration = 0;
let serverThreshold = 10;

async function sendTelemetry() {
  if (mode === 'drown') stillDuration += INTERVAL;
  else stillDuration = 0;

  const isSos = mode === 'sos';
  const isStruggling = mode === 'struggle';
  const motionState = isSos || isStruggling ? 'STRUGGLING' : mode === 'drown' ? 'STILL' : 'NORMAL';

  const accel =
    mode === 'drown'
      ? { x: 0.02, y: 0.04, z: 0.99 }
      : isStruggling || isSos
      ? { x: +(1.2 + Math.random() * 1.1).toFixed(2), y: +(1.3 + Math.random() * 1.1).toFixed(2), z: +(1.6 + Math.random() * 0.9).toFixed(2) }
      : { x: +(0.1 + (Math.random() - 0.5) * 0.2).toFixed(2), y: +(0.85 + (Math.random() - 0.5) * 0.3).toFixed(2), z: +(0.45 + (Math.random() - 0.5) * 0.2).toFixed(2) };

  const payload = {
    deviceId: DEVICE_ID,
    studentName: 'Lý Quốc Bảo',
    class: ZONE === 'TH' ? '5A1' : ZONE === 'THPT' ? '10A1' : '8A1',
    zone: ZONE,
    lane: 3,
    inWater: true,
    motionState,
    stillDuration,
    sosPressed: isSos,
    accel,
    gyro: {
      x: +(1.2 + (Math.random() - 0.5) * 0.5).toFixed(2),
      y: +(-0.8 + (Math.random() - 0.5) * 0.5).toFixed(2),
      z: +(0.5 + (Math.random() - 0.5) * 0.5).toFixed(2),
    },
    tiltAngle: mode === 'drown' ? Math.min(85, 25 + stillDuration * 5) : 12 + Math.floor(Math.random() * 8),
    heartRate: isSos || isStruggling ? 128 : mode === 'drown' ? Math.max(55, 90 - stillDuration * 2) : 88 + Math.floor(Math.random() * 10),
    battery: 94,
    rssi: -54 - Math.floor(Math.random() * 8),
  };

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (API_KEY) headers['X-API-Key'] = API_KEY;
    const res = await fetch(`${URL_BASE}/api/telemetry`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (res.ok) {
      if (json.threshold) serverThreshold = json.threshold;
      if (json.resetSos) {
        mode = 'normal';
        stillDuration = 0;
        console.log(`[SYNC] Nhận lệnh Xác nhận cứu hộ từ Dashboard -> Đã tắt SOS & đặt về Bình thường!`);
      }
      console.log(
        `[${new Date().toLocaleTimeString()}] HTTP ${res.status} | ${DEVICE_ID} | ${motionState} | Bất động: ${stillDuration}/${serverThreshold}s | RSSI: ${payload.rssi}dBm`
      );
    } else {
      console.error(`[${new Date().toLocaleTimeString()}] HTTP ${res.status}:`, json);
    }
  } catch (err) {
    console.error(`[${new Date().toLocaleTimeString()}] Lỗi kết nối máy chủ:`, err.message);
  }
}

console.log('=======================================================');
console.log(`  AquaSentinel v2.5 - Giả lập ESP32: ${DEVICE_ID}`);
console.log(`  Endpoint: ${URL_BASE}/api/telemetry (mỗi ${INTERVAL}s)`);
console.log('  Phím tắt: [n] Bình thường | [s] SOS | [d] Đuối nước | [w] Vùng vẫy | [q] Thoát');
console.log('=======================================================');

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (key) => {
    const k = key.toLowerCase();
    if (k === 'q' || key === '\u0003') process.exit(0);
    if (k === 'n') { mode = 'normal'; stillDuration = 0; console.log('>>> Chuyển chế độ: BÌNH THƯỜNG'); }
    if (k === 's') { mode = 'sos'; console.log('>>> Chuyển chế độ: NÚT SOS KHẨN CẤP!'); }
    if (k === 'd') { mode = 'drown'; stillDuration = 0; console.log('>>> Chuyển chế độ: BẤT ĐỘNG DƯỚI NƯỚC!'); }
    if (k === 'w') { mode = 'struggle'; console.log('>>> Chuyển chế độ: VÙNG VẪY / CHỚI VỚI!'); }
  });
}

sendTelemetry();
setInterval(sendTelemetry, INTERVAL * 1000);
