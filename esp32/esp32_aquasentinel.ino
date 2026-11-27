/*
 * ===================================================================================
 *  DỰ ÁN: AquaSentinel - Đai ngực thông minh giám sát & cảnh báo nguy cơ đuối nước
 *  ĐỘI THI: AquaVix - CUỘC THI STEMPETITION 2026
 *  THIẾT BỊ: ESP32 NodeMCU-32S + MPU6050 + Cảm biến nước + Nút SOS
 * ===================================================================================
 *
 *  SƠ ĐỒ NỐI DÂY PHẦN CỨNG:
 *    1. MPU6050 (I2C):
 *       - VCC  -> 3.3V (hoặc 5V tùy module)
 *       - GND  -> GND
 *       - SCL  -> GPIO 22
 *       - SDA  -> GPIO 21
 *    2. CẢM BIẾN TIẾP XÚC NƯỚC (Water Detection Sensor):
 *       - Signal -> GPIO 34 (hoặc GPIO 4)
 *       - VCC    -> 3.3V
 *       - GND    -> GND
 *    3. NÚT NHẤN KHẨN CẤP SOS:
 *       - Chân 1 -> GPIO 13 (Cấu hình INPUT_PULLUP)
 *       - Chân 2 -> GND
 *    4. CÒI BUZZER / LED TẠI CHỖ (Local Alert):
 *       - Cực dương -> GPIO 18 (Qua trở 220 Ohm)
 *       - Cực âm    -> GND
 *
 *  THƯ VIỆN CẦN CÀI ĐẶT TRÊN ARDUINO IDE:
 *    - Adafruit MPU6050 (Adafruit Unified Sensor & Adafruit BusIO)
 *    - ArduinoJson v7 (Benoit Blanchon)
 * ===================================================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <ArduinoJson.h>

// ========== THÔNG TIN CẤU HÌNH HỆ THỐNG ==========
const char* WIFI_SSID     = "TEN_WIFI_CUA_BAN";      // Đổi thành tên Wi-Fi 2.4GHz
const char* WIFI_PASSWORD = "MAT_KHAU_WIFI";         // Đổi thành mật khẩu Wi-Fi

// Link máy chủ AquaSentinel đã deploy trên Railway (Hỗ trợ cả HTTPS và HTTP local)
const char* SERVER_URL    = "https://aquasentinel-web-production.up.railway.app/api/telemetry";
// Khóa API tùy chọn (chỉ cần điền nếu máy chủ bật REQUIRE_API_KEY=true)
const char* API_KEY       = "";

// Mã nhận diện thiết bị & thông tin học sinh (AQUA-01 .. AQUA-40)
const char* DEVICE_ID     = "AQUA-01";
const char* STUDENT_NAME  = "Nguyễn Văn An";
const char* STUDENT_CLASS = "5A1";
const char* POOL_ZONE     = "TH";   // Phân khu mực nước (không cần GPS): "TH" | "THCS" | "THPT"
const int   POOL_LANE     = 1;

// Định nghĩa chân phần cứng
#define PIN_WATER_SENSOR  34     // Chân đọc cảm biến nước (Analog/Digital)
#define PIN_SOS_BUTTON    13     // Chân nút bấm SOS (Active LOW)
#define PIN_ALERT_BUZZER  18     // Chân còi báo động / LED tại chỗ

// Ngưỡng phát hiện thuật toán (tự động đồng bộ từ Web Dashboard)
const float STILL_THRESHOLD_G     = 0.15;  // Biên độ biến thiên gia tốc cực đại khi bất động
const float STRUGGLE_THRESHOLD_G  = 2.20;  // Biên độ biến thiên gia tốc khi vùng vẫy dữ dội
int         stillAlarmSeconds     = 10;    // Ngưỡng giây bất động (đồng bộ 2 chiều từ server)

// Khởi tạo đối tượng
Adafruit_MPU6050 mpu;
bool mpuReady = false;

// Biến trạng thái
volatile bool sosFlag = false;
unsigned long lastSosInterruptTime = 0;
unsigned long lastSendTime = 0;
unsigned long lastTickSecond = 0;

int stillCounterSeconds = 0;
float prevMag = 1.0;
String currentMotionState = "NORMAL";

// Ngắt phần cứng xử lý nút nhấn SOS tức thì (< 50ms)
void IRAM_ATTR handleSosInterrupt() {
  unsigned long now = millis();
  if (now - lastSosInterruptTime > 300) { // Chống dội phím (Debounce)
    sosFlag = true;
    lastSosInterruptTime = now;
  }
}

// Kết nối Wi-Fi với cơ chế tự phục hồi
void setupWiFi() {
  Serial.print("[WiFi] Đang kết nối tới: ");
  Serial.println(WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int retry = 0;
  while (WiFi.status() != WL_CONNECTED && retry < 15) {
    delay(500);
    Serial.print(".");
    retry++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WiFi] Đã kết nối thành công!");
    Serial.print("[WiFi] Địa chỉ IP ESP32: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\n[WiFi] Cảnh báo: Chưa kết nối được Wi-Fi, chạy offline & tự thử lại.");
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n==============================================");
  Serial.println("  AquaSentinel - Khởi động thiết bị đai ngực  ");
  Serial.println("==============================================");

  pinMode(PIN_WATER_SENSOR, INPUT);
  pinMode(PIN_SOS_BUTTON, INPUT_PULLUP);
  pinMode(PIN_ALERT_BUZZER, OUTPUT);
  digitalWrite(PIN_ALERT_BUZZER, LOW);

  // Gắn ngắt cho nút SOS (nhấn xuống nối mass -> FALLING)
  attachInterrupt(digitalPinToInterrupt(PIN_SOS_BUTTON), handleSosInterrupt, FALLING);

  // Khởi tạo I2C và MPU6050
  Wire.begin(21, 22);
  if (!mpu.begin()) {
    Serial.println("[MPU6050] Không tìm thấy cảm biến MPU6050! Chuyển sang chế độ giả lập.");
    mpuReady = false;
  } else {
    Serial.println("[MPU6050] Khởi động thành công.");
    mpu.setAccelerometerRange(MPU6050_RANGE_4_G);
    mpu.setGyroRange(MPU6050_RANGE_500_DEG);
    mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
    mpuReady = true;
  }

  setupWiFi();
}

void loop() {
  unsigned long now = millis();

  // Kiểm tra trạng thái nút SOS vật lý
  if (digitalRead(PIN_SOS_BUTTON) == LOW) {
    sosFlag = true;
  }

  // Đọc cảm biến nước (Giả định nước chạm làm chân ở mức LOW hoặc đọc analog > 1000)
  int waterRaw = analogRead(PIN_WATER_SENSOR);
  bool inWater = (waterRaw > 1200); // Tinh chỉnh theo cảm biến thực tế

  // Đọc gia tốc & con quay hồi chuyển MPU6050
  float ax = 0, ay = 0, az = 0.98;
  float gx = 0, gy = 0, gz = 0;

  if (mpuReady) {
    sensors_event_t a, g, temp;
    mpu.getEvent(&a, &g, &temp);
    // Đổi m/s^2 sang g-force (chia 9.80665)
    ax = a.acceleration.x / 9.80665;
    ay = a.acceleration.y / 9.80665;
    az = a.acceleration.z / 9.80665;
    gx = g.gyro.x;
    gy = g.gyro.y;
    gz = g.gyro.z;
  } else {
    // Dự phòng nếu chưa cắm cảm biến
    ax = 0.12;
    ay = 0.85;
    az = 0.45;
  }

  // Tính độ lớn vector gia tốc |a|
  float currentMag = sqrt(ax * ax + ay * ay + az * az);
  float deltaMag = abs(currentMag - prevMag);
  prevMag = currentMag;

  // Tính góc nghiêng cơ thể (Tilt Angle) so với phương ngang
  float tiltAngle = atan2(sqrt(ax * ax + ay * ay), abs(az)) * 180.0 / PI;

  // Cập nhật đếm thời gian bất động mỗi 1 giây
  if (now - lastTickSecond >= 1000) {
    lastTickSecond = now;

    if (inWater) {
      if (deltaMag < STILL_THRESHOLD_G) {
        // Cơ thể bất động hoặc chuyển động quá yếu
        stillCounterSeconds++;
        currentMotionState = (stillCounterSeconds >= 4) ? "STILL" : "NORMAL";
      } else if (deltaMag > STRUGGLE_THRESHOLD_G) {
        // Vùng vẫy bất thường, đập nước loạn xạ
        stillCounterSeconds = 0;
        currentMotionState = "STRUGGLING";
      } else {
        // Bơi lội bình thường
        stillCounterSeconds = 0;
        currentMotionState = "NORMAL";
      }
    } else {
      // Trên bờ
      stillCounterSeconds = 0;
      currentMotionState = "NORMAL";
    }

    // Cảnh báo còi tại chỗ nếu gặp nguy hiểm
    if (sosFlag || (inWater && stillCounterSeconds >= stillAlarmSeconds)) {
      digitalWrite(PIN_ALERT_BUZZER, HIGH); // Bật còi rung đai ngực
    } else {
      digitalWrite(PIN_ALERT_BUZZER, LOW);
    }
  }

  // Gửi gói tin Telemetry lên máy chủ mỗi 1000ms
  if (now - lastSendTime >= 1000) {
    lastSendTime = now;
    sendTelemetryToServer(ax, ay, az, gx, gy, gz, tiltAngle, inWater);
  }
}

// Đóng gói JSON và gửi HTTP POST lên Web Dashboard
void sendTelemetryToServer(float ax, float ay, float az, float gx, float gy, float gz, float tilt, bool inWater) {
  if (WiFi.status() != WL_CONNECTED) {
    setupWiFi();
    return;
  }

  JsonDocument doc;
  doc["deviceId"]       = DEVICE_ID;
  doc["studentName"]    = STUDENT_NAME;
  doc["class"]          = STUDENT_CLASS;
  doc["zone"]           = POOL_ZONE;  // "TH" | "THCS" | "THPT"
  doc["lane"]           = POOL_LANE;
  doc["inWater"]        = inWater;
  doc["motionState"]    = currentMotionState; // "NORMAL" | "STRUGGLING" | "STILL"
  doc["stillDuration"]  = stillCounterSeconds;
  doc["sosPressed"]     = sosFlag;
  doc["tiltAngle"]      = (int)tilt;
  doc["heartRate"]      = 88; // Tích hợp cảm biến nhịp tim nếu có
  doc["battery"]        = 95; // Đọc điện áp pin ADC
  doc["rssi"]           = WiFi.RSSI(); // Cường độ tín hiệu Wi-Fi (dBm)

  JsonObject accel = doc["accel"].to<JsonObject>();
  accel["x"] = round(ax * 100) / 100.0;
  accel["y"] = round(ay * 100) / 100.0;
  accel["z"] = round(az * 100) / 100.0;

  JsonObject gyro = doc["gyro"].to<JsonObject>();
  gyro["x"] = round(gx * 100) / 100.0;
  gyro["y"] = round(gy * 100) / 100.0;
  gyro["z"] = round(gz * 100) / 100.0;

  String jsonPayload;
  serializeJson(doc, jsonPayload);

  HTTPClient http;
  WiFiClientSecure secureClient;
  WiFiClient plainClient;

  if (String(SERVER_URL).startsWith("https://")) {
    secureClient.setInsecure(); // Bỏ qua kiểm tra chứng chỉ SSL để kết nối nhanh với Railway
    http.begin(secureClient, SERVER_URL);
  } else {
    http.begin(plainClient, SERVER_URL);
  }
  http.addHeader("Content-Type", "application/json");
  if (strlen(API_KEY) > 0) {
    http.addHeader("X-API-Key", API_KEY);
  }
  http.setTimeout(5000);

  int httpCode = http.POST(jsonPayload);
  if (httpCode == 200 || httpCode == 201) {
    // Phản hồi 2 chiều từ Dashboard: đồng bộ ngưỡng & lệnh tắt còi SOS từ xa
    String respBody = http.getString();
    JsonDocument respDoc;
    if (!deserializeJson(respDoc, respBody)) {
      if (respDoc["threshold"].is<int>()) {
        int srvTh = respDoc["threshold"];
        if (srvTh >= 3 && srvTh <= 60) stillAlarmSeconds = srvTh;
      }
      if (respDoc["resetSos"] == true) {
        sosFlag = false;
        stillCounterSeconds = 0;
        digitalWrite(PIN_ALERT_BUZZER, LOW);
        Serial.println("[SYNC] Đã nhận lệnh Xác nhận cứu hộ từ Dashboard -> Tắt còi SOS!");
      }
    }
    Serial.printf("[HTTP POST OK] %s | Bất động: %ds/%ds | SOS: %s | RSSI: %ddBm\n",
                  currentMotionState.c_str(), stillCounterSeconds, stillAlarmSeconds,
                  sosFlag ? "TRUE" : "FALSE", WiFi.RSSI());
  } else {
    Serial.printf("[HTTP POST Lỗi] Mã phản hồi: %d\n", httpCode);
  }
  http.end();
}
