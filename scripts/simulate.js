// Script giả lập thiết bị đai ngực ESP32 gửi dữ liệu Telemetry lên AquaSentinel Server
// Dùng để kiểm tra kết nối API hoặc trình diễn demo
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

const URL_BASE = (args.url || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const DEVICE_ID = args.device || 'AQUA-11';
const INTERVAL = Number(args.interval) || 2; // gửi mỗi 2 giây

let stillDuration = 0;
let isStruggling = false;
let isSos = false;

async function sendTelemetry() {
  const payload = {
    deviceId: DEVICE_ID,
    studentName: 'Lý Quốc Bảo',
    class: '10A1',
    lane: 3,
    inWater: true,
    motionState: isSos ? 'STRUGGLING' : isStruggling ? 'STRUGGLING' : stillDuration >= 10 ? 'STILL' : 'NORMAL',
    stillDuration: stillDuration,
    sosPressed: isSos,
    accel: {
      x: +(0.1 + (Math.random() - 0.5) * 0.2).toFixed(2),
      y: +(0.85 + (Math.random() - 0.5) * 0.3).toFixed(2),
      z: +(0.45 + (Math.random() - 0.5) * 0.2).toFixed(2),
    },
    gyro: {
      x: +(1.2 + (Math.random() - 0.5) * 0.5).toFixed(2),
      y: +(-0.8 + (Math.random() - 0.5) * 0.5).toFixed(2),
      z: +(0.5 + (Math.random() - 0.5) * 0.5).toFixed(2),
    },
    tiltAngle: 12 + Math.floor(Math.random() * 8),
    heartRate: 88 + Math.floor(Math.random() * 10),
    battery: 94,
  };

  try {
    const res = await fetch(`${URL_BASE}/api/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    console.log(`[${new Date().toLocaleTimeString()}] HTTP ${res.status}: Đã gửi telemetry ${DEVICE_ID} (${payload.motionState})`);
  } catch (err) {
    console.error(`[${new Date().toLocaleTimeString()}] Lỗi kết nối máy chủ:`, err.message);
  }
}

console.log(`=======================================================`);
console.log(`  AquaSentinel - Giả lập ESP32: ${DEVICE_ID}`);
console.log(`  Đang gửi tới: ${URL_BASE}/api/telemetry mỗi ${INTERVAL}s`);
console.log(`=======================================================`);

sendTelemetry();
setInterval(sendTelemetry, INTERVAL * 1000);
