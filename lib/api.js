// Xử lý toàn bộ các API endpoint cho AquaSentinel Dashboard & kết nối ESP32 IoT (v2.5)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const ESP32_CODE_PATH = path.join(__dirname, '..', 'esp32', 'esp32_aquasentinel.ino');
const API_KEY = process.env.API_KEY || '';
const REQUIRE_API_KEY = process.env.REQUIRE_API_KEY === 'true' && API_KEY.length > 0;

function checkApiKey(req) {
  if (!REQUIRE_API_KEY) return true;
  const given = String(req.headers['x-api-key'] || '');
  const a = Buffer.from(given);
  const b = Buffer.from(API_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.end(JSON.stringify(data));
}

async function readJsonBody(req) {
  try {
    if (req.body !== undefined && req.body !== null) {
      return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    }
  } catch {
    throw new Error('INVALID_JSON');
  }
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 256 * 1024) {
        reject(new Error('TOO_LARGE'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('INVALID_JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Danh sách client đang lắng nghe Server-Sent Events (SSE)
const sseClients = new Set();

function buildSnapshot() {
  return {
    type: 'STATUS_UPDATE',
    timestamp: Date.now(),
    kpis: store.getKPIs(),
    students: store.getStudentsWithStatus(),
  };
}

function broadcastNow() {
  if (sseClients.size === 0) return;
  const payload = `data: ${JSON.stringify(buildSnapshot())}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// Định kỳ phát broadcast trạng thái hồ bơi mỗi 850ms
setInterval(broadcastNow, 850);

async function handleApi(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') return send(res, 204, {});

  try {
    // 1. SSE Stream thời gian thực
    if (route === '/api/stream' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(`data: ${JSON.stringify(buildSnapshot())}\n\n`);
      sseClients.add(res);

      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    // 2. Tổng quan trạng thái hồ bơi & KPIs
    if ((route === '/api/pool-status' || route === '/api/status') && method === 'GET') {
      const kpis = store.getKPIs();
      const students = store.getStudentsWithStatus();
      const activeAlerts = students.filter((s) => s.risk.level === 'DANGER' || s.risk.level === 'WARNING');
      return send(res, 200, {
        ok: true,
        timestamp: Date.now(),
        kpis,
        activeAlerts,
        students,
      });
    }

    // 3. Danh sách học sinh
    if (route === '/api/students' && method === 'GET') {
      return send(res, 200, { ok: true, data: store.getStudentsWithStatus() });
    }

    // 4. Chuyển trạng thái Trong bể / Trên bờ cho 1 học sinh
    const toggleMatch = route.match(/^\/api\/students\/([^/]+)\/toggle-water$/);
    if (toggleMatch && method === 'POST') {
      const studentId = decodeURIComponent(toggleMatch[1]);
      const body = await readJsonBody(req);
      const result = store.toggleWater(studentId, body.inWater);
      if (!result.ok) return send(res, 404, result);
      broadcastNow();
      return send(res, 200, result);
    }

    // 4b. Chuyển làn bơi cho 1 học sinh
    const laneMatch = route.match(/^\/api\/students\/([^/]+)\/lane$/);
    if (laneMatch && method === 'POST') {
      const studentId = decodeURIComponent(laneMatch[1]);
      const body = await readJsonBody(req);
      const result = store.setStudentLane(studentId, body.lane);
      if (!result.ok) return send(res, 404, result);
      broadcastNow();
      return send(res, 200, result);
    }

    // 4b2. Chuyển khu vực mực nước (TH / THCS / THPT) cho 1 học sinh
    const zoneMatch = route.match(/^\/api\/students\/([^/]+)\/zone$/);
    if (zoneMatch && method === 'POST') {
      const studentId = decodeURIComponent(zoneMatch[1]);
      const body = await readJsonBody(req);
      const result = store.setStudentZone(studentId, body.zone);
      if (!result.ok) return send(res, 404, result);
      broadcastNow();
      return send(res, 200, result);
    }

    // 4c. Cập nhật hồ sơ học sinh (tên, lớp, SĐT phụ huynh, làn)
    const profileMatch = route.match(/^\/api\/students\/([^/]+)$/);
    if (profileMatch && method === 'PUT') {
      const studentId = decodeURIComponent(profileMatch[1]);
      const body = await readJsonBody(req);
      const result = store.updateStudentProfile(studentId, body || {});
      if (!result.ok) return send(res, 404, result);
      broadcastNow();
      return send(res, 200, result);
    }

    // 4d. Cho tất cả học sinh lên bờ / xuống bể
    if (route === '/api/pool/all-water' && method === 'POST') {
      const body = await readJsonBody(req);
      const result = store.setAllInWater(body.inWater);
      broadcastNow();
      return send(res, 200, result);
    }

    // 5. Lấy chi tiết 1 học sinh theo ID (kèm lịch sử gia tốc MPU6050)
    if (route.startsWith('/api/students/') && method === 'GET') {
      const studentId = decodeURIComponent(route.replace('/api/students/', ''));
      const student = store.getStudentDetail(studentId);
      if (!student) return send(res, 404, { ok: false, error: 'Không tìm thấy học sinh' });
      return send(res, 200, { ok: true, data: student });
    }

    // 6. ESP32 gửi dữ liệu Telemetry (hỗ trợ cả /api/telemetry và /api/data + kiểm tra X-API-Key khi bật REQUIRE_API_KEY)
    if ((route === '/api/telemetry' || route === '/api/data') && method === 'POST') {
      if (!checkApiKey(req)) return send(res, 401, { ok: false, error: 'X-API-Key không hợp lệ' });
      const body = await readJsonBody(req);
      const result = store.receiveTelemetry(body || {});
      if (!result.ok) return send(res, 400, result);
      broadcastNow();
      return send(res, 201, result);
    }

    // 7. Điều khiển chế độ mô phỏng cho Ban Giám Khảo STEMPETITION
    if (route === '/api/simulate' && method === 'POST') {
      const body = await readJsonBody(req);
      const result = store.setSimulationScenario(body.mode, body);
      broadcastNow();
      return send(res, 200, result);
    }

    // 8. Xác nhận cứu hộ / Tắt chuông báo động
    if (route === '/api/resolve-alert' && method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.studentId) return send(res, 400, { ok: false, error: 'Thiếu studentId' });
      const result = store.resolveAlert(body.studentId, body.notes, body.responderName);
      if (!result.ok) return send(res, 404, result);
      broadcastNow();
      return send(res, 200, result);
    }

    // 9. Cài đặt ngưỡng thời gian bất động (giây)
    if (route === '/api/threshold' && method === 'POST') {
      const body = await readJsonBody(req);
      const val = store.setThreshold(body.threshold);
      broadcastNow();
      return send(res, 200, { ok: true, threshold: val });
    }

    // 9b. Thiết lập thông số phiên giám sát (màn hình khởi động & cài đặt)
    if (route === '/api/session-config' && method === 'GET') {
      return send(res, 200, { ok: true, data: store.getSessionConfig() });
    }
    if (route === '/api/session-config' && method === 'POST') {
      const body = await readJsonBody(req);
      const data = store.updateSessionConfig(body || {});
      broadcastNow();
      return send(res, 200, { ok: true, data });
    }

    // 10. Xuất báo cáo CSV nhật ký sự cố cứu hộ
    if (route === '/api/incidents/csv' && method === 'GET') {
      const csv = store.getIncidentsCSV();
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="AquaSentinel_NhatKyCuuHo.csv"');
      res.setHeader('Cache-Control', 'no-store');
      res.end(csv);
      return;
    }

    // 11. Lịch sử các ca xử lý cứu hộ (GET & DELETE)
    if (route === '/api/incidents' && method === 'GET') {
      return send(res, 200, { ok: true, data: store.getIncidents() });
    }
    if (route === '/api/incidents' && method === 'DELETE') {
      store.clearIncidents();
      return send(res, 200, { ok: true });
    }

    // 12. Trả về mã nguồn Arduino ESP32 mới nhất để hiển thị & copy trên giao diện
    if (route === '/api/esp32-code' && method === 'GET') {
      let code = '// Không tìm thấy file mã nguồn esp32/esp32_aquasentinel.ino';
      try {
        if (fs.existsSync(ESP32_CODE_PATH)) {
          code = fs.readFileSync(ESP32_CODE_PATH, 'utf8');
        }
      } catch { /* ignore */ }
      return send(res, 200, { ok: true, filename: 'esp32_aquasentinel.ino', code });
    }

    // 13. Health check
    if (route === '/api/health' && method === 'GET') {
      return send(res, 200, {
        ok: true,
        project: 'AquaSentinel - STEMPETITION',
        team: 'AquaVix',
        version: '2.5.0',
        apiKeyProtected: REQUIRE_API_KEY,
        uptime: Math.round(process.uptime()),
        sseClients: sseClients.size,
        serverTime: Date.now(),
      });
    }

    return send(res, 404, { ok: false, error: 'Endpoint không tồn tại' });
  } catch (err) {
    if (err.message === 'INVALID_JSON') return send(res, 400, { ok: false, error: 'Body JSON không hợp lệ' });
    if (err.message === 'TOO_LARGE') return send(res, 413, { ok: false, error: 'Dung lượng payload quá lớn' });
    console.error('[API Error]:', err);
    return send(res, 500, { ok: false, error: 'Lỗi máy chủ nội bộ' });
  }
}

module.exports = { handleApi };
