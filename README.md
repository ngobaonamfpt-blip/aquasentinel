# 🛟 AquaSentinel - Hệ thống giám sát & cảnh báo nguy cơ đuối nước tại bể bơi trường học
### 🏆 Dự án tham gia cuộc thi STEMPETITION 2026 • Đội thi AquaVix

![AquaSentinel Badge](https://img.shields.io/badge/STEMPETITION-2026_AquaVix-5170FF?style=for-the-badge&logo=shield)
![ESP32](https://img.shields.io/badge/Hardware-ESP32_NodeMCU-red?style=for-the-badge)
![MPU6050](https://img.shields.io/badge/Sensor-MPU6050_6DOF-blue?style=for-the-badge)
![Node.js](https://img.shields.io/badge/Backend-Node.js_Zero_Dep-green?style=for-the-badge)

---

## 📖 1. Giới thiệu Dự án

**AquaSentinel** là giải pháp công nghệ an toàn trường học kết hợp giữa **Thiết bị đai ngực thông minh IoT** và **Hệ thống Web Dashboard giám sát trung tâm trên bờ**, phục vụ trực tiếp cho giáo viên thể chất và nhân viên cứu hộ tại các bể bơi học sinh (20–40 em cùng lúc).

### 💡 Bối cảnh & Tính cấp thiết:
Tai nạn đuối nước ở trẻ em và học sinh thường diễn ra trong **im lặng (Silent Drowning)**: nạn nhân khi bị ngạt nước hoặc kiệt sức/chuột rút sẽ chìm dần mà không thể la hét hay vẫy tay kêu cứu. AquaSentinel giải quyết triệt để vấn đề này bằng cách tự động phát hiện trạng thái bất động dưới nước hoặc chuyển động hoảng loạn, còi báo động sẽ hú to trên bờ chỉ trong vòng **10 giây**.

---

## ⚙️ 2. Kiến trúc Hệ thống & Phần cứng

Hệ thống bao gồm 2 thành phần chính:

```
[ Đai ngực thông minh học sinh ]
  ├── Vi điều khiển ESP32 NodeMCU-32S
  ├── Cảm biến gia tốc & con quay hồi chuyển 6-DOF (MPU6050)
  ├── Cảm biến nhận diện tiếp xúc nước (Water Level Sensor)
  └── Nút bấm khẩn cấp SOS (Hardware Interrupt)
          │
          ▼ Wi-Fi (HTTP POST / WebSocket)
[ AquaSentinel Web Dashboard (Trung tâm trên bờ) ]
  ├── Giao diện iPad / Laptop cho Giáo viên thể chất & Cứu hộ
  ├── Sơ đồ hồ bơi trực quan (25m × 12.5m, 5 làn bơi, độ sâu 1.2m & 1.8m)
  ├── Còi hú báo động âm thanh thực tế (Web Audio API Dual-tone Siren)
  └── Bảng điều khiển giả lập kịch bản Demo phục vụ Ban Giám Khảo
```

### Sơ đồ chân nối phần cứng ESP32:
- **MPU6050 (I2C):** `SDA -> GPIO 21`, `SCL -> GPIO 22`, `VCC -> 3.3V`, `GND -> GND`
- **Cảm biến tiếp xúc nước:** `Chân tín hiệu -> GPIO 34`, `VCC -> 3.3V`, `GND -> GND`
- **Nút bấm khẩn cấp SOS:** `Chân tín hiệu -> GPIO 13 (INPUT_PULLUP)`, `Chân còn lại -> GND`
- **Còi buzzer / LED đai ngực:** `Cực dương -> GPIO 18 (qua trở 220Ω)`, `Cực âm -> GND`

---

## 🧠 3. Thuật toán Nhận diện Đuối nước

1. **Nhận diện Trong nước / Trên bờ:** Đọc cảm biến nước qua chân GPIO 34. Khi học sinh ở trên bờ nghỉ ngơi, bộ đếm bất động tự động vô hiệu hóa để tránh báo động giả.
2. **Đo độ lớn biến thiên vector gia tốc:**
   $$\Delta |a| = \left| \sqrt{a_x^2 + a_y^2 + a_z^2} - |a_{prev}| \right|$$
3. **Phát hiện Bất động dưới nước (Silent Drowning):**
   - Khi $\Delta |a| < 0.15g$ liên tục trong nước $\rightarrow$ `stillDuration` tăng mỗi giây.
   - Nếu `stillDuration` $\ge$ **10 giây** (ngưỡng tùy chỉnh) $\rightarrow$ **KÍCH HOẠT BÁO ĐỘNG ĐỎ KHẨN CẤP!**
4. **Phát hiện Vùng vẫy / Chới với bất thường (Struggling):**
   - Khi $\Delta |a| > 2.20g$ dao động đột ngột $\rightarrow$ Cảnh báo màu vàng để giáo viên chú ý quan sát.
5. **Nút SOS Khẩn cấp:**
   - Sử dụng Ngắt phần cứng `attachInterrupt(FALLING)` phản hồi tức thì dưới **50ms**.

---

## 🚀 4. Hướng dẫn Khởi chạy Dashboard

Dự án được tối ưu bằng **Node.js thuần**, **không cần cài thêm bất kỳ thư viện npm nặng nề nào**, giúp BGK và người dùng có thể chạy ngay lập tức.

### Bước 1: Khởi động máy chủ Web
```bash
# Di chuyển vào thư mục dự án
cd steampitison

# Khởi chạy máy chủ (Mặc định cổng 3000)
npm start
```

Mở trình duyệt truy cập: **`http://localhost:3000`**

### Bước 2: Thử nghiệm truyền dữ liệu giả lập từ thiết bị
Mở một cửa sổ dòng lệnh thứ hai và chạy:
```bash
npm run simulate
```
Script sẽ giả lập thiết bị `AQUA-11` truyền dữ liệu gia tốc và nhịp tim liên tục lên máy chủ.

---

## 🎯 5. Hướng dẫn Trình diễn Demo trước Ban Giám Khảo

Ở góc dưới màn hình giao diện có thanh **"Bảng điều khiển Giả lập Demo (STEMPETITION)"**:

1. **Nút `🟢 Bình thường`:** Toàn bộ 30 học sinh bơi lội an toàn nhịp nhàng trong 5 làn bơi.
2. **Nút `🚨 Bấm nút SOS`:** Mô phỏng học sinh Lý Quốc Bảo (Làn 3) bấm nút SOS $\rightarrow$ Viền màn hình chớp đỏ, còi hú cứu hộ phát ra qua loa, xuất hiện Modal cấp cứu với vị trí Làn 3 (Khu sâu 1.8m).
3. **Nút `⚠️ Bất động 12s`:** Mô phỏng học sinh bị chuột rút chìm xuống đáy $\rightarrow$ Bộ đếm thời gian nhảy từ 1s đến 12s $\rightarrow$ Vượt ngưỡng 10s $\rightarrow$ Còi báo động kích hoạt.
4. **Nút `⚡ Chới với / Vùng vẫy`:** Mô phỏng dao động gia tốc mạnh $\rightarrow$ Icon học sinh rung lắc và chuyển màu vàng cảnh báo.
5. **Thanh trượt Slider:** Tùy biến ngưỡng cảnh báo bất động từ 5s đến 25s trước mặt Ban giám khảo.
6. **Nút `Xác nhận đã cứu nạn / Tắt còi`:** Ghi nhận lịch sử cứu hộ vào bảng "Nhật ký xử lý sự cố" minh bạch thời gian phản ứng.

---

## 📡 6. Tài liệu API Endpoints

### 1. Gửi dữ liệu cảm biến từ ESP32:
- **Endpoint:** `POST /api/telemetry`
- **Content-Type:** `application/json`
- **Payload mẫu:**
```json
{
  "deviceId": "AQUA-11",
  "studentName": "Lý Quốc Bảo",
  "class": "10A1",
  "lane": 3,
  "inWater": true,
  "motionState": "STILL",
  "stillDuration": 12,
  "sosPressed": false,
  "tiltAngle": 15,
  "accel": { "x": 0.05, "y": 0.12, "z": 0.98 },
  "gyro": { "x": 1.2, "y": 0.5, "z": -0.8 },
  "heartRate": 88,
  "battery": 94
}
```

### 2. Lấy dữ liệu toàn bộ hồ bơi:
- **Endpoint:** `GET /api/pool-status`
- **Mô tả:** Trả về KPIs, danh sách 30+ học sinh và các ca cảnh báo khẩn cấp.

### 3. Server-Sent Events (SSE):
- **Endpoint:** `GET /api/stream`
- **Mô tả:** Cập nhật dữ liệu thời gian thực không độ trễ.

---

## 👥 Đội ngũ Phát triển: Đội AquaVix
- Dự án tham dự cuộc thi: **STEMPETITION 2026**
- Đề tài: *Ứng dụng IoT và AI nhận diện bất động trong phòng chống đuối nước trường học.*
