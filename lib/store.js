// Bộ lưu trữ dữ liệu thời gian thực cho hệ thống AquaSentinel (v2.5)
// Quản lý trạng thái học sinh, dữ liệu phần cứng ESP32 (2 chiều), lịch sử gia tốc MPU6050, cấu hình phiên & nhật ký cứu hộ

const fs = require('fs');
const path = require('path');

const PERSIST = !process.env.VERCEL && process.env.PERSIST !== 'false';
const DATA_DIR = path.join(__dirname, '..', 'data');
const INCIDENTS_FILE = path.join(DATA_DIR, 'incidents.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const HARDWARE_TIMEOUT_MS = 15000; // 15 giây: giữ dữ liệu phần cứng ESP32 thật không bị mô phỏng ghi đè
const MAX_ACCEL_HISTORY = 40;

// Ngưỡng thời gian bất động mặc định (giây)
let stillThresholdSeconds = 10;

// Cấu hình phiên giám sát (do giáo viên thiết lập tại màn hình khởi động)
let sessionConfig = {
  schoolName: 'Bể bơi trường học (25m × 12.5m)',
  className: 'Bơi lội • Lớp 10A1 & 10A2',
  supervisorName: 'Thầy Trần Hữu Nghĩa',
  studentCount: 30,
  poolLength: 25,
  poolWidth: 12.5,
  poolArea: 312.5,
  thDepth: 0.9,
  thcsDepth: 1.3,
  thptDepth: 1.8,
  shallowDepth: 0.9,
  deepDepth: 1.8,
  waterTemp: 28.2,
  waterPh: 7.3,
  dataMode: 'hardware', // 'hardware' (chỉ hiện ESP32 thật) | 'demo' (giả lập học sinh)
  configured: false,
};

const VALID_ZONES = ['TH', 'THCS', 'THPT'];
function normalizeZone(z, fallback = 'THCS') {
  const s = String(z || '').trim().toUpperCase();
  return VALID_ZONES.includes(s) ? s : fallback;
}
function getZoneBounds(zone, poolLen) {
  const len = poolLen || 25;
  const third = len / 3;
  const pad = Math.min(1.1, third * 0.14);
  if (zone === 'TH') return { min: pad, max: third - pad };
  if (zone === 'THPT') return { min: third * 2 + pad, max: len - pad };
  return { min: third + pad, max: third * 2 - pad };
}
function getZoneMeta(zone) {
  if (zone === 'TH') return { key: 'TH', short: 'TH', label: 'Khu Tiểu học (TH)', depthLabel: 'Nông', depth: sessionConfig.thDepth || 0.9 };
  if (zone === 'THPT') return { key: 'THPT', short: 'THPT', label: 'Khu THPT', depthLabel: 'Sâu', depth: sessionConfig.thptDepth || 1.8 };
  return { key: 'THCS', short: 'THCS', label: 'Khu THCS', depthLabel: 'Trung bình', depth: sessionConfig.thcsDepth || 1.3 };
}

const EXTRA_NAMES = [
  'Nguyễn Gia Bảo', 'Trần Ngọc Ánh', 'Lê Minh Khôi', 'Phạm Thu Trang', 'Hoàng Đức Anh',
  'Vũ Hải Yến', 'Đặng Quốc Khánh', 'Bùi Phương Linh', 'Đỗ Minh Trí', 'Ngô Thanh Hà',
];

// Danh sách ban đầu 30 học sinh thực tế (lớp 10A1 & 10A2)
const INITIAL_STUDENTS = [
  { id: 'AQUA-01', name: 'Nguyễn Văn An', class: '10A1', lane: 1, inWater: true, posX: 3.2, posY: 2.1, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 96, heartRate: 88, tiltAngle: 12, accel: { x: 0.12, y: 0.85, z: 0.45 }, gyro: { x: 2.1, y: -1.4, z: 0.8 }, emergencyContact: '0901.234.567 (Bố)' },
  { id: 'AQUA-02', name: 'Trần Thị Mai', class: '10A1', lane: 1, inWater: true, posX: 8.5, posY: 2.3, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 92, heartRate: 92, tiltAngle: 15, accel: { x: 0.08, y: 0.92, z: 0.38 }, gyro: { x: 1.8, y: -0.9, z: 1.1 }, emergencyContact: '0902.345.678 (Mẹ)' },
  { id: 'AQUA-03', name: 'Lê Hoàng Nam', class: '10A1', lane: 1, inWater: true, posX: 14.1, posY: 2.0, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 88, heartRate: 85, tiltAngle: 10, accel: { x: 0.15, y: 0.88, z: 0.42 }, gyro: { x: 2.5, y: -1.2, z: 0.6 }, emergencyContact: '0903.456.789 (Bố)' },
  { id: 'AQUA-04', name: 'Phạm Minh Đức', class: '10A1', lane: 1, inWater: true, posX: 19.8, posY: 2.2, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 95, heartRate: 90, tiltAngle: 18, accel: { x: 0.05, y: 0.79, z: 0.52 }, gyro: { x: 1.2, y: -0.8, z: 0.9 }, emergencyContact: '0904.567.890 (Mẹ)' },
  { id: 'AQUA-05', name: 'Đỗ Quỳnh Anh', class: '10A1', lane: 1, inWater: false, posX: 23.5, posY: 0.8, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 90, heartRate: 78, tiltAngle: 5, accel: { x: 0.02, y: 0.04, z: 0.99 }, gyro: { x: 0.1, y: 0.0, z: 0.1 }, emergencyContact: '0905.678.901 (Bố)' },

  { id: 'AQUA-06', name: 'Vũ Gia Huy', class: '10A1', lane: 2, inWater: true, posX: 5.4, posY: 4.5, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 94, heartRate: 86, tiltAngle: 14, accel: { x: 0.10, y: 0.82, z: 0.48 }, gyro: { x: 2.0, y: -1.5, z: 0.7 }, emergencyContact: '0906.789.012 (Mẹ)' },
  { id: 'AQUA-07', name: 'Hoàng Tuấn Kiệt', class: '10A1', lane: 2, inWater: true, posX: 11.2, posY: 4.4, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 89, heartRate: 95, tiltAngle: 16, accel: { x: 0.14, y: 0.78, z: 0.54 }, gyro: { x: 2.3, y: -1.1, z: 1.2 }, emergencyContact: '0907.890.123 (Bố)' },
  { id: 'AQUA-08', name: 'Bùi Ngọc Hân', class: '10A1', lane: 2, inWater: true, posX: 16.8, posY: 4.6, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 91, heartRate: 89, tiltAngle: 11, accel: { x: 0.09, y: 0.86, z: 0.41 }, gyro: { x: 1.7, y: -1.3, z: 0.8 }, emergencyContact: '0908.901.234 (Mẹ)' },
  { id: 'AQUA-09', name: 'Đặng Quang Minh', class: '10A1', lane: 2, inWater: true, posX: 21.0, posY: 4.5, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 93, heartRate: 84, tiltAngle: 13, accel: { x: 0.11, y: 0.80, z: 0.50 }, gyro: { x: 1.9, y: -0.7, z: 1.0 }, emergencyContact: '0909.012.345 (Bố)' },
  { id: 'AQUA-10', name: 'Ngô Bảo Châu', class: '10A1', lane: 2, inWater: false, posX: 1.5, posY: 0.8, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 97, heartRate: 75, tiltAngle: 6, accel: { x: 0.01, y: 0.03, z: 0.98 }, gyro: { x: 0.2, y: 0.1, z: 0.0 }, emergencyContact: '0910.123.456 (Mẹ)' },

  { id: 'AQUA-11', name: 'Lý Quốc Bảo', class: '10A1', lane: 3, inWater: true, posX: 4.8, posY: 6.8, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 90, heartRate: 91, tiltAngle: 12, accel: { x: 0.13, y: 0.84, z: 0.46 }, gyro: { x: 2.2, y: -1.0, z: 0.9 }, emergencyContact: '0911.234.567 (Bố)' },
  { id: 'AQUA-12', name: 'Dương Thảo Linh', class: '10A1', lane: 3, inWater: true, posX: 9.6, posY: 6.7, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 87, heartRate: 88, tiltAngle: 15, accel: { x: 0.07, y: 0.89, z: 0.39 }, gyro: { x: 1.6, y: -1.4, z: 0.7 }, emergencyContact: '0912.345.678 (Mẹ)' },
  { id: 'AQUA-13', name: 'Võ Thành Đạt', class: '10A1', lane: 3, inWater: true, posX: 15.3, posY: 6.9, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 95, heartRate: 93, tiltAngle: 17, accel: { x: 0.16, y: 0.77, z: 0.55 }, gyro: { x: 2.4, y: -0.8, z: 1.3 }, emergencyContact: '0913.456.789 (Bố)' },
  { id: 'AQUA-14', name: 'Mai Khánh Huyền', class: '10A1', lane: 3, inWater: true, posX: 20.4, posY: 6.8, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 94, heartRate: 87, tiltAngle: 14, accel: { x: 0.09, y: 0.85, z: 0.43 }, gyro: { x: 1.8, y: -1.2, z: 0.8 }, emergencyContact: '0914.567.890 (Mẹ)' },
  { id: 'AQUA-15', name: 'Trịnh Hữu Phước', class: '10A1', lane: 3, inWater: true, posX: 12.0, posY: 6.8, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 89, heartRate: 90, tiltAngle: 13, accel: { x: 0.12, y: 0.81, z: 0.49 }, gyro: { x: 2.0, y: -1.1, z: 1.0 }, emergencyContact: '0915.678.901 (Bố)' },

  { id: 'AQUA-16', name: 'Đoàn Nhật Minh', class: '10A2', lane: 4, inWater: true, posX: 3.8, posY: 9.1, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 96, heartRate: 85, tiltAngle: 11, accel: { x: 0.11, y: 0.87, z: 0.40 }, gyro: { x: 2.1, y: -1.3, z: 0.9 }, emergencyContact: '0916.789.012 (Mẹ)' },
  { id: 'AQUA-17', name: 'Nguyễn Phương Thảo', class: '10A2', lane: 4, inWater: true, posX: 8.9, posY: 9.2, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 91, heartRate: 89, tiltAngle: 16, accel: { x: 0.08, y: 0.83, z: 0.47 }, gyro: { x: 1.7, y: -0.9, z: 1.1 }, emergencyContact: '0917.890.123 (Bố)' },
  { id: 'AQUA-18', name: 'Lê Tuấn Khang', class: '10A2', lane: 4, inWater: true, posX: 14.6, posY: 9.0, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 88, heartRate: 94, tiltAngle: 18, accel: { x: 0.15, y: 0.76, z: 0.56 }, gyro: { x: 2.5, y: -1.2, z: 0.6 }, emergencyContact: '0918.901.234 (Mẹ)' },
  { id: 'AQUA-19', name: 'Phan Diệu Linh', class: '10A2', lane: 4, inWater: true, posX: 19.2, posY: 9.3, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 93, heartRate: 86, tiltAngle: 12, accel: { x: 0.10, y: 0.88, z: 0.42 }, gyro: { x: 1.9, y: -1.0, z: 0.8 }, emergencyContact: '0919.012.345 (Bố)' },
  { id: 'AQUA-20', name: 'Tạ Minh Hoàng', class: '10A2', lane: 4, inWater: false, posX: 18.0, posY: 11.8, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 85, heartRate: 76, tiltAngle: 7, accel: { x: 0.03, y: 0.05, z: 0.98 }, gyro: { x: 0.1, y: 0.1, z: 0.0 }, emergencyContact: '0920.123.456 (Mẹ)' },

  { id: 'AQUA-21', name: 'Hồ Trí Dũng', class: '10A2', lane: 5, inWater: true, posX: 5.1, posY: 11.2, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 92, heartRate: 92, tiltAngle: 15, accel: { x: 0.12, y: 0.82, z: 0.48 }, gyro: { x: 2.0, y: -1.4, z: 0.7 }, emergencyContact: '0921.234.567 (Bố)' },
  { id: 'AQUA-22', name: 'Trương Yến Nhi', class: '10A2', lane: 5, inWater: true, posX: 10.5, posY: 11.4, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 95, heartRate: 87, tiltAngle: 13, accel: { x: 0.09, y: 0.85, z: 0.44 }, gyro: { x: 1.8, y: -1.1, z: 1.0 }, emergencyContact: '0922.345.678 (Mẹ)' },
  { id: 'AQUA-23', name: 'Đặng Tuấn Vũ', class: '10A2', lane: 5, inWater: true, posX: 15.9, posY: 11.1, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 89, heartRate: 90, tiltAngle: 17, accel: { x: 0.14, y: 0.79, z: 0.53 }, gyro: { x: 2.3, y: -0.8, z: 1.2 }, emergencyContact: '0923.456.789 (Bố)' },
  { id: 'AQUA-24', name: 'Vũ Thảo Vy', class: '10A2', lane: 5, inWater: true, posX: 21.5, posY: 11.3, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 97, heartRate: 83, tiltAngle: 10, accel: { x: 0.07, y: 0.90, z: 0.37 }, gyro: { x: 1.5, y: -1.3, z: 0.8 }, emergencyContact: '0924.567.890 (Mẹ)' },
  { id: 'AQUA-25', name: 'Nguyễn Đức Long', class: '10A2', lane: 5, inWater: false, posX: 6.0, posY: 11.8, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 90, heartRate: 74, tiltAngle: 4, accel: { x: 0.02, y: 0.02, z: 0.99 }, gyro: { x: 0.1, y: 0.0, z: 0.1 }, emergencyContact: '0925.678.901 (Bố)' },

  { id: 'AQUA-26', name: 'Bùi Hữu Đăng', class: '10A2', lane: 1, inWater: true, posX: 11.0, posY: 2.1, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 93, heartRate: 88, tiltAngle: 14, accel: { x: 0.11, y: 0.84, z: 0.46 }, gyro: { x: 2.1, y: -1.2, z: 0.9 }, emergencyContact: '0926.789.012 (Mẹ)' },
  { id: 'AQUA-27', name: 'Cao Mỹ Duyên', class: '10A2', lane: 2, inWater: true, posX: 8.0, posY: 4.5, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 94, heartRate: 86, tiltAngle: 12, accel: { x: 0.08, y: 0.88, z: 0.41 }, gyro: { x: 1.8, y: -1.0, z: 0.8 }, emergencyContact: '0927.890.123 (Bố)' },
  { id: 'AQUA-28', name: 'Lê Minh Quân', class: '10A2', lane: 3, inWater: true, posX: 17.5, posY: 6.8, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 91, heartRate: 91, tiltAngle: 16, accel: { x: 0.13, y: 0.80, z: 0.51 }, gyro: { x: 2.2, y: -1.1, z: 1.1 }, emergencyContact: '0928.901.234 (Mẹ)' },
  { id: 'AQUA-29', name: 'Chu Quỳnh Nga', class: '10A2', lane: 4, inWater: true, posX: 11.8, posY: 9.1, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 96, heartRate: 85, tiltAngle: 13, accel: { x: 0.10, y: 0.86, z: 0.43 }, gyro: { x: 1.9, y: -1.2, z: 0.7 }, emergencyContact: '0929.012.345 (Bố)' },
  { id: 'AQUA-30', name: 'Lâm Thanh Phong', class: '10A2', lane: 5, inWater: true, posX: 13.5, posY: 11.2, motionState: 'NORMAL', stillDuration: 0, sosPressed: false, battery: 88, heartRate: 89, tiltAngle: 15, accel: { x: 0.12, y: 0.81, z: 0.49 }, gyro: { x: 2.0, y: -0.9, z: 1.0 }, emergencyContact: '0930.123.456 (Mẹ)' },
];

const DEFAULT_INCIDENTS = [
  {
    id: 'INC-001',
    timestamp: Date.now() - 1000 * 60 * 18,
    studentId: 'AQUA-07',
    studentName: 'Hoàng Tuấn Kiệt',
    lane: 2,
    triggerType: 'STRUGGLING',
    description: 'Vùng vẫy bất thường do chuột rút tại khu vực sâu 1.8m',
    responseTimeSeconds: 8,
    status: 'RESOLVED',
    resolvedBy: 'Thầy Trần Hữu Nghĩa (GV Thể chất)',
  },
  {
    id: 'INC-002',
    timestamp: Date.now() - 1000 * 60 * 55,
    studentId: 'AQUA-13',
    studentName: 'Võ Thành Đạt',
    lane: 3,
    triggerType: 'STILL_TIMEOUT',
    description: 'Bất động 11 giây khi tập lặn nín thở vượt ngưỡng an toàn',
    responseTimeSeconds: 6,
    status: 'RESOLVED',
    resolvedBy: 'Cứu hộ Lê Văn Hùng',
  },
];

// Lịch sử gia tốc 40 mẫu cho từng học sinh (giữ riêng ngoài object student để payload SSE gọn nhẹ)
const accelHistoryMap = new Map();
const directionMap = {};
const initialInWaterMap = {};
// Cờ lệnh gửi ngược về ESP32 (ví dụ: reset SOS & tắt còi đai ngực sau khi giáo viên xác nhận cứu hộ)
const pendingResetSos = new Set();

let students = JSON.parse(JSON.stringify(INITIAL_STUDENTS));
students.forEach((s, idx) => {
  // Phân bổ mặc định 30 học sinh đều vào 3 khu vực mực nước (TH: 1-10, THCS: 11-20, THPT: 21-30)
  if (!s.zone) {
    s.zone = idx < 10 ? 'TH' : idx < 20 ? 'THCS' : 'THPT';
    if (s.zone === 'TH') s.class = '5A' + ((idx % 2) + 1);
    else if (s.zone === 'THCS') s.class = '8A' + ((idx % 2) + 1);
    else s.class = '10A' + ((idx % 2) + 1);
  }
  const b = getZoneBounds(s.zone, sessionConfig.poolLength);
  s.posX = +(b.min + ((idx * 1.9) % Math.max(1, b.max - b.min))).toFixed(1);
  directionMap[s.id] = idx % 2 === 0 ? 1 : -1;
  initialInWaterMap[s.id] = s.inWater;
  s.speed = +(0.22 + (idx % 4) * 0.05).toFixed(2);
  s.lastHardwareSeen = 0;
  s.rssi = null;
  s.dangerStartedAt = null;

  // Khởi tạo sẵn 30 mẫu sóng bơi tự nhiên
  const hist = [];
  for (let i = 0; i < 30; i++) {
    const phase = i * 0.4 + s.lane;
    if (s.inWater) {
      hist.push({
        x: +(0.1 + Math.sin(phase) * 0.16).toFixed(2),
        y: +(0.82 + Math.cos(phase * 0.8) * 0.18).toFixed(2),
        z: +(0.45 + Math.sin(phase * 0.6) * 0.12).toFixed(2),
      });
    } else {
      hist.push({ x: 0.02, y: 0.04, z: 0.99 });
    }
  }
  accelHistoryMap.set(s.id, hist);
});

function pushAccelSample(studentId, accel) {
  if (!accel) return;
  let arr = accelHistoryMap.get(studentId);
  if (!arr) {
    arr = [];
    accelHistoryMap.set(studentId, arr);
  }
  arr.push({
    x: Number(accel.x) || 0,
    y: Number(accel.y) || 0,
    z: Number(accel.z) || 0,
  });
  if (arr.length > MAX_ACCEL_HISTORY) arr.shift();
}

function writeJsonAtomic(filePath, data) {
  if (!PERSIST) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
  } catch (err) {
    console.warn(`[store] Không ghi được ${path.basename(filePath)}:`, err.message);
  }
}

// Nạp / lưu nhật ký cứu hộ & cấu hình phiên bền vững
let incidents = JSON.parse(JSON.stringify(DEFAULT_INCIDENTS));
function loadPersistedData() {
  if (!PERSIST) return;
  try {
    if (fs.existsSync(INCIDENTS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(INCIDENTS_FILE, 'utf8'));
      if (Array.isArray(parsed) && parsed.length > 0) incidents = parsed.slice(0, 100);
    }
  } catch (err) {
    console.warn('[store] Không đọc được incidents.json:', err.message);
  }
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (saved && typeof saved === 'object') {
        if (saved.sessionConfig && typeof saved.sessionConfig === 'object') {
          Object.assign(sessionConfig, saved.sessionConfig);
          ensureStudentPoolSize(sessionConfig.studentCount);
        }
        if (Number.isFinite(Number(saved.threshold))) {
          stillThresholdSeconds = Math.max(3, Math.min(60, Number(saved.threshold)));
        }
      }
    }
  } catch (err) {
    console.warn('[store] Không đọc được config.json:', err.message);
  }
}

function saveIncidents() {
  writeJsonAtomic(INCIDENTS_FILE, incidents);
}

function saveConfig() {
  writeJsonAtomic(CONFIG_FILE, { sessionConfig, threshold: stillThresholdSeconds });
}

// Trạng thái mô phỏng
let simulationMode = 'normal'; // 'normal' | 'sos' | 'silent_drowning' | 'struggling'
let targetStudentId = 'AQUA-11';

function isHardwareLive(s) {
  return Boolean(s.lastHardwareSeen && Date.now() - s.lastHardwareSeen < HARDWARE_TIMEOUT_MS);
}

// Hàm cập nhật mốc thời gian bắt đầu nguy hiểm để tính response time thật
function syncDangerClock(s) {
  const risk = getRiskStatus(s);
  if (risk.level === 'DANGER') {
    if (!s.dangerStartedAt) s.dangerStartedAt = Date.now();
  } else {
    s.dangerStartedAt = null;
  }
}

// Hàm tick chu kỳ 1 giây
function tickSwimmers() {
  const now = Date.now();
  students.forEach((s) => {
    // 1. Nếu thiết bị đang nhận tín hiệu ESP32 thật -> KHÔNG ghi đè dữ liệu cảm biến!
    if (isHardwareLive(s)) {
      pushAccelSample(s.id, s.accel);
      syncDangerClock(s);
      return;
    }

    // 2. Nếu là học sinh đang chạy kịch bản mô phỏng Demo
    if (s.id === targetStudentId && simulationMode !== 'normal') {
      if (simulationMode === 'sos') {
        s.sosPressed = true;
        s.motionState = 'STRUGGLING';
        s.tiltAngle = 48 + Math.floor(Math.sin(now / 300) * 10);
        s.inWater = true;
        s.accel = {
          x: +(1.2 + Math.random() * 0.9).toFixed(2),
          y: +(1.4 + Math.random() * 0.9).toFixed(2),
          z: +(1.8 + Math.random() * 0.8).toFixed(2),
        };
        s.heartRate = 128 + Math.floor(Math.random() * 10);
      } else if (simulationMode === 'silent_drowning') {
        s.sosPressed = false;
        s.motionState = 'STILL';
        s.inWater = true;
        s.stillDuration = (s.stillDuration || 0) + 1;
        s.tiltAngle = Math.min(85, 22 + s.stillDuration * 5);
        s.accel = {
          x: +(0.02 + (Math.random() - 0.5) * 0.02).toFixed(2),
          y: +(0.05 + (Math.random() - 0.5) * 0.02).toFixed(2),
          z: +(0.98 + (Math.random() - 0.5) * 0.02).toFixed(2),
        };
        s.gyro = { x: 0.04, y: -0.02, z: 0.01 };
        s.heartRate = Math.max(52, 92 - s.stillDuration * 2);
      } else if (simulationMode === 'struggling') {
        s.sosPressed = false;
        s.motionState = 'STRUGGLING';
        s.stillDuration = 0;
        s.inWater = true;
        s.tiltAngle = 38 + Math.floor(Math.random() * 32);
        s.accel = {
          x: +(Math.random() * 2.8 - 1.4).toFixed(2),
          y: +(Math.random() * 3.0 - 1.5).toFixed(2),
          z: +(1.1 + Math.random() * 2.2).toFixed(2),
        };
        s.heartRate = 122 + Math.floor(Math.random() * 16);
      }
      pushAccelSample(s.id, s.accel);
      syncDangerClock(s);
      return;
    }

    // 3. Các học sinh bơi bình thường theo làn
    if (s.inWater) {
      s.stillDuration = 0;
      s.sosPressed = false;
      s.motionState = 'NORMAL';

      const dir = directionMap[s.id] || 1;
      const poolLen = sessionConfig.poolLength || 25;
      const bounds = getZoneBounds(normalizeZone(s.zone), poolLen);
      s.posX += dir * (s.speed || 0.28);
      if (s.posX >= bounds.max) {
        s.posX = bounds.max;
        directionMap[s.id] = -1;
      } else if (s.posX <= bounds.min) {
        s.posX = bounds.min;
        directionMap[s.id] = 1;
      }
      s.posX = Math.round(s.posX * 10) / 10;

      const wave = Math.sin(now / 1000 + s.lane + s.posX * 0.3);
      s.accel = {
        x: +(0.1 + wave * 0.16).toFixed(2),
        y: +(0.82 + Math.cos(now / 800 + s.lane) * 0.18).toFixed(2),
        z: +(0.45 + wave * 0.11).toFixed(2),
      };
      s.gyro = {
        x: +(1.5 + wave * 1.0).toFixed(2),
        y: +(-1.0 + Math.cos(now / 900) * 0.8).toFixed(2),
        z: +(0.8 + wave * 0.5).toFixed(2),
      };
      s.tiltAngle = Math.round(10 + Math.abs(wave) * 10);
      s.heartRate = 82 + Math.floor(Math.abs(wave) * 16);
    } else {
      s.motionState = 'NORMAL';
      s.stillDuration = 0;
      s.sosPressed = false;
      s.accel = { x: 0.02, y: 0.04, z: 0.99 };
      s.gyro = { x: 0.1, y: 0.0, z: 0.1 };
      s.tiltAngle = 4;
      s.heartRate = 75;
    }
    pushAccelSample(s.id, s.accel);
    syncDangerClock(s);
  });
}

setInterval(tickSwimmers, 1000);

// Tính toán trạng thái rủi ro
function getRiskStatus(student) {
  if (student.sosPressed) {
    return {
      level: 'DANGER',
      reason: 'NÚT SOS KHẨN CẤP ĐÃ ĐƯỢC BẤM!',
      code: 'SOS_TRIGGERED',
      color: '#EF4444',
      badge: 'NGUY HIỂM (SOS)',
    };
  }
  if (student.inWater && student.stillDuration >= stillThresholdSeconds) {
    return {
      level: 'DANGER',
      reason: `Bất động dưới nước ${student.stillDuration}s (vượt ngưỡng ${stillThresholdSeconds}s)!`,
      code: 'STILL_OVERDUE',
      color: '#EF4444',
      badge: 'NGUY HIỂM (BẤT ĐỘNG)',
    };
  }
  if (student.inWater && student.motionState === 'STRUGGLING') {
    return {
      level: 'WARNING',
      reason: 'Phát hiện gia tốc rung lắc mạnh - Dấu hiệu chới với/vùng vẫy!',
      code: 'STRUGGLING_DETECTED',
      color: '#F59E0B',
      badge: 'CẢNH BÁO (VÙNG VẪY)',
    };
  }
  if (student.inWater && student.stillDuration >= Math.max(3, Math.floor(stillThresholdSeconds * 0.6))) {
    return {
      level: 'WARNING',
      reason: `Bất động ${student.stillDuration}s (tiệm cận ngưỡng ${stillThresholdSeconds}s)`,
      code: 'STILL_APPROACHING',
      color: '#F59E0B',
      badge: 'CHÚ Ý (BẤT ĐỘNG)',
    };
  }
  return {
    level: 'SAFE',
    reason: student.inWater ? 'Đang bơi an toàn nhịp nhàng' : 'Đang nghỉ ngơi trên bờ',
    code: 'NORMAL',
    color: student.inWater ? '#10B981' : '#64748B',
    badge: student.inWater ? 'AN TOÀN' : 'TRÊN BỜ',
  };
}

function ensureStudentPoolSize(count) {
  const targetCount = Math.min(40, Math.max(5, Number(count) || 30));
  while (students.length < targetCount) {
    const num = students.length + 1;
    const id = `AQUA-${String(num).padStart(2, '0')}`;
    const lane = ((num - 1) % 5) + 1;
    const zone = VALID_ZONES[(num - 1) % 3];
    const bounds = getZoneBounds(zone, sessionConfig.poolLength);
    const name = EXTRA_NAMES[(num - 31) % EXTRA_NAMES.length] || `Học sinh ${num}`;
    const s = {
      id,
      name,
      class: zone === 'TH' ? '5A2' : zone === 'THCS' ? '8A2' : '10A2',
      zone,
      lane,
      inWater: true,
      posX: +(bounds.min + ((num * 1.7) % Math.max(1, bounds.max - bounds.min))).toFixed(1),
      posY: +(lane * 2.2).toFixed(1),
      motionState: 'NORMAL',
      stillDuration: 0,
      sosPressed: false,
      battery: 90 + (num % 10),
      heartRate: 86,
      tiltAngle: 12,
      accel: { x: 0.1, y: 0.85, z: 0.45 },
      gyro: { x: 1.8, y: -1.1, z: 0.8 },
      emergencyContact: `09${String(30 + num).slice(-2)}.123.456 (Phụ huynh)`,
      speed: +(0.34 + (num % 4) * 0.06).toFixed(2),
      lastHardwareSeen: 0,
      rssi: null,
      dangerStartedAt: null,
    };
    students.push(s);
    directionMap[id] = num % 2 === 0 ? 1 : -1;
    initialInWaterMap[id] = true;
    const hist = [];
    for (let i = 0; i < 30; i++) {
      hist.push({
        x: +(0.1 + Math.sin(i * 0.4 + lane) * 0.15).toFixed(2),
        y: +(0.82 + Math.cos(i * 0.35 + lane) * 0.17).toFixed(2),
        z: +(0.45 + Math.sin(i * 0.3 + lane) * 0.1).toFixed(2),
      });
    }
    accelHistoryMap.set(id, hist);
  }
}

loadPersistedData();

function getActiveStudentsRaw() {
  // Chế độ phần cứng thật: CHỈ hiển thị các thiết bị ESP32 đang thực sự kết nối gửi dữ liệu
  if (sessionConfig.dataMode === 'hardware') {
    return students.filter((s) => isHardwareLive(s));
  }
  const limit = Math.min(40, Math.max(5, Number(sessionConfig.studentCount) || 30));
  const base = students.slice(0, limit);
  const baseIds = new Set(base.map((s) => s.id));
  for (let i = limit; i < students.length; i++) {
    if (isHardwareLive(students[i]) && !baseIds.has(students[i].id)) {
      base.push(students[i]);
    }
  }
  return base;
}

function enrichStudent(s, includeHistory = false) {
  const risk = getRiskStatus(s);
  const zone = normalizeZone(s.zone, 'THCS');
  const zMeta = getZoneMeta(zone);
  const poolZone = s.inWater ? `${zMeta.label} (${zMeta.depth}m)` : 'Bờ hồ';
  const depthMeter = s.inWater ? zMeta.depth : 0;
  const hwOnline = isHardwareLive(s);
  const lastSeenAgo = s.lastHardwareSeen ? Math.max(0, Math.round((Date.now() - s.lastHardwareSeen) / 1000)) : null;
  const out = {
    ...s,
    zone,
    zoneLabel: zMeta.label,
    direction: directionMap[s.id] || 1,
    isHardwareOnline: hwOnline,
    lastSeenAgo,
    risk,
    poolZone,
    depthMeter,
  };
  if (includeHistory) {
    out.accelHistory = accelHistoryMap.get(s.id) || [];
  }
  return out;
}

function getStudentsWithStatus() {
  return getActiveStudentsRaw().map((s) => enrichStudent(s, false));
}

function getStudentDetail(id) {
  const s = students.find((x) => x.id === id);
  return s ? enrichStudent(s, true) : null;
}

function getKPIs() {
  const list = getStudentsWithStatus();
  const total = list.length;
  const inWater = list.filter((s) => s.inWater).length;
  const onDeck = total - inWater;
  const safe = list.filter((s) => s.risk.level === 'SAFE').length;
  const warning = list.filter((s) => s.risk.level === 'WARNING').length;
  const danger = list.filter((s) => s.risk.level === 'DANGER').length;
  const hardwareOnlineCount = list.filter((s) => s.isHardwareOnline).length;

  return {
    total,
    inWater,
    onDeck,
    safe,
    warning,
    danger,
    hardwareOnlineCount,
    threshold: stillThresholdSeconds,
    simulationMode,
    targetStudentId,
    sessionConfig,
  };
}

// Cập nhật thông tin hồ sơ học sinh (tên, lớp, SĐT phụ huynh, làn bơi, khu vực mực nước)
function updateStudentProfile(studentId, data = {}) {
  const s = students.find((x) => x.id === studentId);
  if (!s) return { ok: false, error: 'Không tìm thấy học sinh' };
  if (typeof data.name === 'string' && data.name.trim()) s.name = data.name.trim().slice(0, 80);
  if (typeof data.class === 'string' && data.class.trim()) s.class = data.class.trim().slice(0, 20);
  if (typeof data.emergencyContact === 'string') s.emergencyContact = data.emergencyContact.trim().slice(0, 80);
  if (data.lane !== undefined) {
    const nextLane = Math.min(5, Math.max(1, Math.round(Number(data.lane) || s.lane)));
    s.lane = nextLane;
    s.posY = +(nextLane * 2.2).toFixed(1);
  }
  if (data.zone !== undefined) {
    s.zone = normalizeZone(data.zone, s.zone || 'THCS');
    const b = getZoneBounds(s.zone, sessionConfig.poolLength);
    s.posX = +((b.min + b.max) / 2).toFixed(1);
  }
  return { ok: true, student: enrichStudent(s, false) };
}

// Chuyển khu vực mực nước (TH / THCS / THPT) cho 1 học sinh
function setStudentZone(studentId, zone) {
  return updateStudentProfile(studentId, { zone });
}

// Nhận dữ liệu Telemetry từ ESP32 thực tế (hỗ trợ phản hồi 2 chiều: threshold + resetSos)
function receiveTelemetry(data) {
  const rawId = data.deviceId || data.device_id;
  const deviceId = typeof rawId === 'string' ? rawId.trim() : '';
  if (!deviceId || deviceId.length > 64) {
    return { ok: false, error: 'Thiếu hoặc sai định dạng deviceId' };
  }

  // Hỗ trợ chuẩn hóa nhẹ (ví dụ AQUA_01 hoặc AQUA-01 đều khớp nếu trùng số)
  let student = students.find((s) => s.id === deviceId || s.id.replace('-', '_') === deviceId);
  if (!student) {
    const lane = Math.min(5, Math.max(1, Number(data.lane) || 1));
    const zone = normalizeZone(data.zone, 'THCS');
    const b = getZoneBounds(zone, sessionConfig.poolLength);
    student = {
      id: deviceId,
      name: data.studentName || data.name || `Học sinh ${deviceId}`,
      class: data.class || (zone === 'TH' ? '5A1' : zone === 'THCS' ? '8A1' : '10A1'),
      zone,
      lane,
      inWater: data.inWater !== undefined ? Boolean(data.inWater) : true,
      posX: +((b.min + b.max) / 2).toFixed(1),
      posY: lane * 2.2,
      motionState: data.motionState || 'NORMAL',
      stillDuration: Math.max(0, Number(data.stillDuration) || 0),
      sosPressed: Boolean(data.sosPressed),
      battery: Math.min(100, Math.max(0, Number(data.battery) || 100)),
      heartRate: Number(data.heartRate) || 85,
      tiltAngle: Number(data.tiltAngle) || 12,
      rssi: Number.isFinite(Number(data.rssi)) ? Number(data.rssi) : null,
      accel: data.accel || { x: 0.1, y: 0.8, z: 0.4 },
      gyro: data.gyro || { x: 1.0, y: -0.5, z: 0.5 },
      emergencyContact: data.emergencyContact || '0900.000.000',
      speed: 0.4,
      dangerStartedAt: null,
    };
    students.push(student);
    directionMap[student.id] = 1;
  } else {
    if (data.studentName) student.name = String(data.studentName).slice(0, 80);
    if (data.class) student.class = String(data.class).slice(0, 20);
    if (data.zone !== undefined) {
      const nextZ = normalizeZone(data.zone, student.zone || 'THCS');
      if (nextZ !== student.zone) {
        student.zone = nextZ;
        const b = getZoneBounds(nextZ, sessionConfig.poolLength);
        student.posX = +((b.min + b.max) / 2).toFixed(1);
      }
    }
    if (data.lane !== undefined) student.lane = Math.min(5, Math.max(1, Number(data.lane) || student.lane));
    if (data.inWater !== undefined) student.inWater = Boolean(data.inWater);
    if (data.motionState && ['NORMAL', 'STRUGGLING', 'STILL'].includes(data.motionState)) {
      student.motionState = data.motionState;
    }
    if (data.stillDuration !== undefined) student.stillDuration = Math.max(0, Number(data.stillDuration) || 0);
    if (data.sosPressed !== undefined) student.sosPressed = Boolean(data.sosPressed);
    if (data.battery !== undefined) student.battery = Math.min(100, Math.max(0, Number(data.battery)));
    if (data.heartRate !== undefined) student.heartRate = Number(data.heartRate);
    if (data.tiltAngle !== undefined) student.tiltAngle = Number(data.tiltAngle);
    if (data.rssi !== undefined && Number.isFinite(Number(data.rssi))) student.rssi = Math.round(Number(data.rssi));
    if (data.accel && typeof data.accel === 'object') {
      student.accel = {
        x: Number(data.accel.x) || 0,
        y: Number(data.accel.y) || 0,
        z: Number(data.accel.z) || 0,
      };
    }
    if (data.gyro && typeof data.gyro === 'object') {
      student.gyro = {
        x: Number(data.gyro.x) || 0,
        y: Number(data.gyro.y) || 0,
        z: Number(data.gyro.z) || 0,
      };
    }
  }

  // Nếu giáo viên vừa bấm "Xác nhận cứu hộ" trên web -> báo lệnh resetSos ngược lại ESP32
  let resetSos = false;
  if (pendingResetSos.has(student.id)) {
    resetSos = true;
    pendingResetSos.delete(student.id);
    student.sosPressed = false;
    student.stillDuration = 0;
  }

  student.lastSeen = Date.now();
  student.lastHardwareSeen = Date.now();
  pushAccelSample(student.id, student.accel);
  syncDangerClock(student);

  return {
    ok: true,
    threshold: stillThresholdSeconds,
    resetSos,
    serverTime: Date.now(),
    student: enrichStudent(student, false),
  };
}

// Kích hoạt kịch bản mô phỏng demo cho BGK
function setSimulationScenario(mode, options = {}) {
  sessionConfig.dataMode = 'demo'; // Tự động chuyển sang chế độ Demo khi bấm nút giả lập
  const validModes = ['normal', 'sos', 'silent_drowning', 'struggling'];
  const nextMode = validModes.includes(mode) ? mode : 'normal';

  // Dọn trạng thái cũ của mục tiêu trước đó (tránh kẹt trạng thái khi đổi học sinh)
  const prevTarget = students.find((s) => s.id === targetStudentId);
  if (prevTarget && !isHardwareLive(prevTarget)) {
    prevTarget.sosPressed = false;
    prevTarget.stillDuration = 0;
    prevTarget.motionState = 'NORMAL';
    prevTarget.dangerStartedAt = null;
  }

  simulationMode = nextMode;
  if (options.studentId && students.some((s) => s.id === options.studentId)) {
    targetStudentId = options.studentId;
  }
  if (options.threshold !== undefined) {
    stillThresholdSeconds = Math.max(3, Math.min(60, Number(options.threshold) || 10));
  }

  const target = students.find((s) => s.id === targetStudentId);

  if (simulationMode === 'normal') {
    students.forEach((s) => {
      if (isHardwareLive(s)) return;
      s.sosPressed = false;
      s.stillDuration = 0;
      s.motionState = 'NORMAL';
      s.dangerStartedAt = null;
      if (initialInWaterMap[s.id] !== undefined) {
        s.inWater = initialInWaterMap[s.id];
      }
    });
  } else if (target) {
    // Cho phép demo ghi đè tạm ngay cả khi thiết bị vừa test telemetry
    target.lastHardwareSeen = 0;
    const b = getZoneBounds(normalizeZone(target.zone), sessionConfig.poolLength);
    const midX = +((b.min + b.max) / 2).toFixed(1);
    if (simulationMode === 'sos') {
      target.inWater = true;
      target.sosPressed = true;
      target.motionState = 'STRUGGLING';
      target.stillDuration = 0;
      target.posX = midX;
      syncDangerClock(target);
    } else if (simulationMode === 'silent_drowning') {
      target.inWater = true;
      target.sosPressed = false;
      target.motionState = 'STILL';
      target.stillDuration = options.initialStill !== undefined ? Number(options.initialStill) : 1;
      target.posX = midX;
      syncDangerClock(target);
    } else if (simulationMode === 'struggling') {
      target.inWater = true;
      target.sosPressed = false;
      target.motionState = 'STRUGGLING';
      target.stillDuration = 0;
      target.posX = midX;
      syncDangerClock(target);
    }
  }

  return { ok: true, simulationMode, targetStudentId, threshold: stillThresholdSeconds };
}

// Chuyển đổi trạng thái Trong bể / Trên bờ thủ công (điểm danh nhanh)
function toggleWater(studentId, forceState) {
  const s = students.find((x) => x.id === studentId);
  if (!s) return { ok: false, error: 'Không tìm thấy học sinh' };
  s.inWater = typeof forceState === 'boolean' ? forceState : !s.inWater;
  if (!s.inWater) {
    s.stillDuration = 0;
    s.sosPressed = false;
    s.motionState = 'NORMAL';
    s.dangerStartedAt = null;
    if (s.id === targetStudentId) simulationMode = 'normal';
  } else if (s.posX < 2 || s.posX > (sessionConfig.poolLength || 25) - 2) {
    s.posX = +(3 + Math.random() * Math.max(4, (sessionConfig.poolLength || 25) - 6)).toFixed(1);
  }
  return { ok: true, student: enrichStudent(s, false) };
}

// Chuyển làn bơi cho 1 học sinh
function setStudentLane(studentId, lane) {
  const s = students.find((x) => x.id === studentId);
  if (!s) return { ok: false, error: 'Không tìm thấy học sinh' };
  const nextLane = Math.min(5, Math.max(1, Math.round(Number(lane) || s.lane)));
  s.lane = nextLane;
  s.posY = +(nextLane * 2.2).toFixed(1);
  return { ok: true, student: enrichStudent(s, false) };
}

// Đưa tất cả học sinh lên bờ (giải lao / kết thúc tiết) hoặc xuống bể
function setAllInWater(inWater) {
  const flag = Boolean(inWater);
  const poolLen = sessionConfig.poolLength || 25;
  getActiveStudentsRaw().forEach((s) => {
    if (isHardwareLive(s)) return;
    s.inWater = flag;
    s.stillDuration = 0;
    s.sosPressed = false;
    s.motionState = 'NORMAL';
    s.dangerStartedAt = null;
    if (flag && (s.posX < 2 || s.posX > poolLen - 2)) {
      s.posX = +(2 + Math.random() * Math.max(4, poolLen - 4)).toFixed(1);
    }
  });
  simulationMode = 'normal';
  return { ok: true, inWater: flag };
}

// Xác nhận cứu hộ hoàn tất & tắt cảnh báo (đồng thời gửi lệnh tắt còi về ESP32 thật nếu đang kết nối)
function resolveAlert(studentId, notes = '', responderName = 'Giáo viên thể chất') {
  const student = students.find((s) => s.id === studentId);
  if (!student) return { ok: false, error: 'Không tìm thấy học sinh' };

  const responseTimeSeconds = student.dangerStartedAt
    ? Math.max(1, Math.round((Date.now() - student.dangerStartedAt) / 1000))
    : 5;

  const incident = {
    id: `INC-${Date.now().toString().slice(-5)}`,
    timestamp: Date.now(),
    studentId: student.id,
    studentName: student.name,
    lane: student.lane,
    triggerType: student.sosPressed ? 'SOS_BUTTON' : 'STILL_DROWNING_TIMEOUT',
    description:
      notes ||
      (student.sosPressed
        ? `Xử lý báo động nút SOS tại Làn ${student.lane}`
        : `Đưa lên bờ an toàn sau ${student.stillDuration}s bất động tại Làn ${student.lane}`),
    responseTimeSeconds,
    status: 'RESOLVED',
    resolvedBy: responderName || sessionConfig.supervisorName || 'Giáo viên thể chất',
  };

  incidents.unshift(incident);
  if (incidents.length > 100) incidents.pop();
  saveIncidents();

  // Nếu là thiết bị ESP32 thật -> đánh dấu resetSos để gói phản hồi tiếp theo tắt còi & xóa cờ SOS trên mạch
  if (isHardwareLive(student)) {
    pendingResetSos.add(student.id);
  }

  // Reset trạng thái an toàn và đưa lên bờ nghỉ kiểm tra sức khỏe
  student.sosPressed = false;
  student.stillDuration = 0;
  student.motionState = 'NORMAL';
  student.dangerStartedAt = null;
  if (!pendingResetSos.has(student.id)) {
    student.lastHardwareSeen = 0;
  }
  student.inWater = false;

  if (simulationMode !== 'normal' && student.id === targetStudentId) {
    simulationMode = 'normal';
  }

  return { ok: true, incident, student: enrichStudent(student, false) };
}

function getIncidents() {
  return incidents;
}

function clearIncidents() {
  incidents = [];
  saveIncidents();
  return { ok: true };
}

function getIncidentsCSV() {
  const header = ['MaSuCo', 'ThoiGian', 'MaThietBi', 'HocSinh', 'LanBoi', 'LoaiCanhBao', 'ThoiGianPhanUng(s)', 'NguoiXuLy', 'MoTa'];
  const csvEsc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = incidents.map((i) => [
    i.id,
    new Date(i.timestamp).toLocaleString('vi-VN'),
    i.studentId,
    i.studentName,
    i.lane,
    i.triggerType,
    i.responseTimeSeconds,
    i.resolvedBy,
    i.description,
  ].map(csvEsc).join(','));
  // Thêm UTF-8 BOM để Excel trên Windows mở tiếng Việt không bị lỗi font
  return '\uFEFF' + [header.join(','), ...rows].join('\r\n');
}

function setThreshold(sec) {
  stillThresholdSeconds = Math.max(3, Math.min(60, Number(sec) || 10));
  students.forEach(syncDangerClock);
  saveConfig();
  return stillThresholdSeconds;
}

function getSessionConfig() {
  return { ...sessionConfig, threshold: stillThresholdSeconds };
}

function updateSessionConfig(cfg = {}) {
  if (typeof cfg.schoolName === 'string' && cfg.schoolName.trim()) {
    sessionConfig.schoolName = cfg.schoolName.trim().slice(0, 80);
  }
  if (typeof cfg.className === 'string' && cfg.className.trim()) {
    sessionConfig.className = cfg.className.trim().slice(0, 80);
  }
  if (typeof cfg.supervisorName === 'string' && cfg.supervisorName.trim()) {
    sessionConfig.supervisorName = cfg.supervisorName.trim().slice(0, 80);
  }
  if (cfg.studentCount !== undefined) {
    const count = Math.min(40, Math.max(5, Math.round(Number(cfg.studentCount) || 30)));
    sessionConfig.studentCount = count;
    ensureStudentPoolSize(count);
    const active = getActiveStudentsRaw();
    if (!active.some((s) => s.id === targetStudentId) && active.length > 0) {
      targetStudentId = active[0].id;
    }
  }
  if (cfg.thDepth !== undefined) {
    const val = Number(cfg.thDepth);
    if (Number.isFinite(val) && val >= 0.4 && val <= 2.5) {
      sessionConfig.thDepth = Math.round(val * 10) / 10;
      sessionConfig.shallowDepth = sessionConfig.thDepth;
    }
  }
  if (cfg.thcsDepth !== undefined) {
    const val = Number(cfg.thcsDepth);
    if (Number.isFinite(val) && val >= 0.6 && val <= 3.0) {
      sessionConfig.thcsDepth = Math.round(val * 10) / 10;
    }
  }
  if (cfg.thptDepth !== undefined) {
    const val = Number(cfg.thptDepth);
    if (Number.isFinite(val) && val >= 0.8 && val <= 5.0) {
      sessionConfig.thptDepth = Math.round(val * 10) / 10;
      sessionConfig.deepDepth = sessionConfig.thptDepth;
    }
  }
  if (cfg.shallowDepth !== undefined && cfg.thDepth === undefined) {
    const val = Number(cfg.shallowDepth);
    if (Number.isFinite(val) && val >= 0.4 && val <= 3.0) {
      sessionConfig.shallowDepth = Math.round(val * 10) / 10;
      sessionConfig.thDepth = sessionConfig.shallowDepth;
    }
  }
  if (cfg.deepDepth !== undefined && cfg.thptDepth === undefined) {
    const val = Number(cfg.deepDepth);
    if (Number.isFinite(val) && val >= 0.8 && val <= 5.0) {
      sessionConfig.deepDepth = Math.round(val * 10) / 10;
      sessionConfig.thptDepth = sessionConfig.deepDepth;
    }
  }
  if (cfg.waterTemp !== undefined) {
    const val = Number(cfg.waterTemp);
    if (Number.isFinite(val) && val >= 10 && val <= 45) {
      sessionConfig.waterTemp = Math.round(val * 10) / 10;
    }
  }
  if (cfg.waterPh !== undefined) {
    const val = Number(cfg.waterPh);
    if (Number.isFinite(val) && val >= 5 && val <= 9) {
      sessionConfig.waterPh = Math.round(val * 10) / 10;
    }
  }
  if (cfg.poolLength !== undefined) {
    const len = Number(cfg.poolLength);
    if (Number.isFinite(len) && len >= 8 && len <= 100) {
      const oldLen = sessionConfig.poolLength || 25;
      sessionConfig.poolLength = Math.round(len * 10) / 10;
      const ratio = sessionConfig.poolLength / oldLen;
      students.forEach((s) => {
        s.posX = Math.round(Math.max(1, Math.min(sessionConfig.poolLength - 1, s.posX * ratio)) * 10) / 10;
      });
    }
  }
  if (cfg.poolWidth !== undefined) {
    const wid = Number(cfg.poolWidth);
    if (Number.isFinite(wid) && wid >= 4 && wid <= 50) {
      sessionConfig.poolWidth = Math.round(wid * 10) / 10;
    }
  }
  sessionConfig.poolArea = Math.round(sessionConfig.poolLength * sessionConfig.poolWidth * 10) / 10;
  if (cfg.threshold !== undefined) {
    stillThresholdSeconds = Math.max(3, Math.min(60, Number(cfg.threshold) || 10));
    students.forEach(syncDangerClock);
  }
  if (cfg.dataMode === 'hardware' || cfg.dataMode === 'demo') {
    sessionConfig.dataMode = cfg.dataMode;
    if (cfg.dataMode === 'hardware') {
      simulationMode = 'normal';
    }
  }
  sessionConfig.configured = true;
  saveConfig();
  return getSessionConfig();
}

module.exports = {
  getStudentsWithStatus,
  getStudentDetail,
  getKPIs,
  receiveTelemetry,
  updateStudentProfile,
  setSimulationScenario,
  toggleWater,
  setStudentLane,
  setStudentZone,
  setAllInWater,
  resolveAlert,
  getIncidents,
  clearIncidents,
  getIncidentsCSV,
  setThreshold,
  getSessionConfig,
  updateSessionConfig,
};
