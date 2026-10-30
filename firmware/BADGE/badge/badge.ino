// STEAMWorkz badge: LilyGO T5 4.7" (ESP32-WROVER, 960 x 540 e-paper, 16 greys).
// It never draws anything itself: the deck's BADGE tab sends finished frames over BLE
// (src/ble/badge.js), this shows them and keeps the last one for the next power-up.
//
// Build (Arduino IDE):
//   board    ESP32 Dev Module, PSRAM: Enabled, Partition: Huge APP (3MB No OTA/1MB SPIFFS)
//   libs     LilyGo-EPD47 (github.com/Xinyuan-LilyGO/LilyGo-EPD47)
//            NimBLE-Arduino 2.x (Library Manager)
//
// BLE: advertises as RIG-BADGE, one service, two characteristics:
//   RX (write)   'B' u32 len | 'D' data... | 'E' | 'C' | '?'
//   TX (notify)  READY | OK | ERR <why> | INFO <w> <h> <battery mV>
// A frame is the panel's own 960 x 540, 4 bits a pixel (0 black, 15 white), left pixel in
// the low nibble, PackBits-compressed: n < 128 = n+1 literal bytes, n > 128 = the next
// byte 257-n times.

#include <Arduino.h>
#include <NimBLEDevice.h>
#include <LittleFS.h>
#include "epd_driver.h"

#define SERVICE_UUID "7a1e0001-5d2c-4e8b-9c1f-3b6a8d0e4f21"
#define RX_UUID      "7a1e0002-5d2c-4e8b-9c1f-3b6a8d0e4f21"
#define TX_UUID      "7a1e0003-5d2c-4e8b-9c1f-3b6a8d0e4f21"
#define BATT_PIN     36
#define FRAME_BYTES  (EPD_WIDTH * EPD_HEIGHT / 2)     // 259 200
#define MAX_PACKED   (FRAME_BYTES + FRAME_BYTES / 128 + 16)
#define FRAME_FILE   "/frame.pb"

static uint8_t *frame;               // unpacked, what the panel shows (PSRAM)
static uint8_t *packed;              // the incoming frame, still packed (PSRAM)
static size_t packedLen = 0, packedGot = 0;
static NimBLECharacteristic *tx;

// Work the BLE callbacks hand to loop(): drawing takes seconds, the BLE task mustn't wait.
static volatile bool wantDraw = false, wantClear = false, wantInfo = false;

static void say(const char *s) {
  tx->setValue((const uint8_t *)s, strlen(s));
  tx->notify();
}

static bool unpack(const uint8_t *src, size_t n, uint8_t *dst, size_t want) {
  size_t i = 0, o = 0;
  while (i < n) {
    uint8_t c = src[i++];
    if (c < 128) {
      size_t len = c + 1;
      if (i + len > n || o + len > want) return false;
      memcpy(dst + o, src + i, len);
      i += len;
      o += len;
    } else if (c > 128) {
      size_t len = 257 - c;
      if (i >= n || o + len > want) return false;
      memset(dst + o, src[i++], len);
      o += len;
    }
  }
  return o == want;
}

static void show() {
  epd_poweron();
  epd_clear();
  epd_draw_grayscale_image(epd_full_screen(), frame);
  epd_poweroff();
}

class RxCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *c, NimBLEConnInfo &info) override {
    NimBLEAttValue v = c->getValue();
    const uint8_t *d = v.data();
    size_t n = v.length();
    if (!n) return;
    switch (d[0]) {
      case 'B':
        if (n < 5) return say("ERR short");
        packedLen = d[1] | d[2] << 8 | d[3] << 16 | (uint32_t)d[4] << 24;
        packedGot = 0;
        if (packedLen == 0 || packedLen > MAX_PACKED) { packedLen = 0; return say("ERR size"); }
        say("READY");
        break;
      case 'D':
        if (!packedLen || packedGot + n - 1 > packedLen) return say("ERR overrun");
        memcpy(packed + packedGot, d + 1, n - 1);
        packedGot += n - 1;
        break;
      case 'E':
        if (!packedLen || packedGot != packedLen) return say("ERR incomplete");
        wantDraw = true;
        break;
      case 'C':
        wantClear = true;
        break;
      case '?':
        wantInfo = true;
        break;
    }
  }
};

class ServerCallbacks : public NimBLEServerCallbacks {
  void onDisconnect(NimBLEServer *s, NimBLEConnInfo &info, int reason) override {
    packedLen = packedGot = 0;           // a half-sent frame is dropped
    NimBLEDevice::startAdvertising();
  }
};

void setup() {
  Serial.begin(115200);
  frame = (uint8_t *)ps_malloc(FRAME_BYTES);
  packed = (uint8_t *)ps_malloc(MAX_PACKED);
  if (!frame || !packed) {
    Serial.println("badge: no PSRAM (Tools > PSRAM: Enabled)");
    while (true) delay(1000);
  }
  memset(frame, 0xFF, FRAME_BYTES);
  epd_init();

  // The panel keeps its picture with the power off; redraw the last one in case it was
  // wiped (e.g. after flashing).
  if (LittleFS.begin(true)) {
    File f = LittleFS.open(FRAME_FILE, "r");
    if (f) {
      size_t n = f.read(packed, MAX_PACKED);
      f.close();
      if (unpack(packed, n, frame, FRAME_BYTES)) show();
    }
  }

  NimBLEDevice::init("RIG-BADGE");
  NimBLEDevice::setMTU(517);
  NimBLEServer *server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  NimBLEService *svc = server->createService(SERVICE_UUID);
  NimBLECharacteristic *rx = svc->createCharacteristic(RX_UUID, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR, 512);
  rx->setCallbacks(new RxCallbacks());
  tx = svc->createCharacteristic(TX_UUID, NIMBLE_PROPERTY::NOTIFY);
  svc->start();
  // Just the name in the advert (a 128-bit UUID wouldn't fit beside it); the deck
  // finds the badge by name and asks for the service by UUID.
  NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
  adv->setName("RIG-BADGE");
  adv->start();
  Serial.println("badge: ready, advertising as RIG-BADGE");
}

void loop() {
  if (wantDraw) {
    wantDraw = false;
    size_t n = packedLen;
    packedLen = 0;
    if (!unpack(packed, n, frame, FRAME_BYTES)) {
      say("ERR unpack");
    } else {
      show();
      File f = LittleFS.open(FRAME_FILE, "w");
      if (f) { f.write(packed, n); f.close(); }
      say("OK");
    }
  }
  if (wantClear) {
    wantClear = false;
    memset(frame, 0xFF, FRAME_BYTES);
    epd_poweron();
    epd_clear();
    epd_poweroff();
    LittleFS.remove(FRAME_FILE);
    say("OK");
  }
  if (wantInfo) {
    wantInfo = false;
    epd_poweron();                       // the battery divider only reads with the panel powered
    delay(10);
    uint32_t mv = analogReadMilliVolts(BATT_PIN) * 2;
    epd_poweroff();
    char s[40];
    snprintf(s, sizeof s, "INFO %d %d %lu", EPD_WIDTH, EPD_HEIGHT, (unsigned long)mv);
    say(s);
  }
  delay(10);
}
