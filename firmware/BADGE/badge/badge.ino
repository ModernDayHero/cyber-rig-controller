// STEAMWorkz badge: LilyGO T5 4.7" (ESP32-WROVER, 960 x 540 e-paper, 16 greys).
// It never draws anything itself: the deck's BADGE tab sends finished frames over BLE
// (src/ble/badge.js) into screen slots, kept in flash, and this shows them.
//
//   slot 0     the login QR (guest page)          kept until replaced
//   slot 1     the STEAMWorkz card (two QRs)      kept until replaced
//   slots 2-5  the last four guest portraits      a ring: a new one replaces the oldest
//   slot 6     an invite: WANNA EDGERUN? + QR + a one-time password; stays up until the
//              deck puts the login QR back (the password used, revoked or expired)
//
// Two ways to wear it (the deck sets it, kept in flash):
//   WORN   a new portrait shows for `hold` seconds, then back to the login QR
//   TABLE  photo frame: a slideshow, login QR -> each portrait -> login QR..., `hold`
//          seconds each; a new portrait jumps the queue
// Buttons: KEY 1 flips login QR <-> STEAMWorkz card; KEY 2 shows the next portrait.
//
// Build (Arduino IDE):
//   board    ESP32 Dev Module, PSRAM: Enabled, Partition: Huge APP (3MB No OTA/1MB SPIFFS)
//   libs     LilyGo-EPD47 (github.com/Xinyuan-LilyGO/LilyGo-EPD47)
//            NimBLE-Arduino 2.x (Library Manager)
//
// BLE: advertises as RIG-BADGE, one service, two characteristics:
//   RX (write)   'B' u32 len u8 slot (255 = next portrait) | 'D' data... | 'E'
//                'S' u8 slot (show it) | 'M' u8 mode (0 worn, 1 table) u16 hold s
//                'C' (clear the panel) | '?'
//   TX (notify)  READY | OK | ERR <why> | INFO <w> <h> <battery mV> <slots bitmask> <mode> <hold> <showing>
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
#define KEY_1        34      // T5 4.7" (ESP32) side keys; check against your board's silkscreen
#define KEY_2        35
#define FRAME_BYTES  (EPD_WIDTH * EPD_HEIGHT / 2)     // 259 200
#define MAX_PACKED   (FRAME_BYTES + FRAME_BYTES / 128 + 16)
#define SLOTS        7
#define FIRST_GUEST  2
#define LAST_GUEST   5
#define INVITE_SLOT  6

static uint8_t *frame;               // unpacked, what the panel shows (PSRAM)
static uint8_t *packed;              // the incoming frame, still packed (PSRAM)
static size_t packedLen = 0, packedGot = 0;
static uint8_t packedSlot = 0;
static NimBLECharacteristic *tx;

static uint8_t mode = 0;             // 0 worn, 1 table
static uint16_t hold = 180;          // seconds a portrait stays (worn) / each slide (table)
static int showing = -1;             // slot on the panel now (-1: none / cleared)
static uint8_t nextGuest = FIRST_GUEST;
static uint32_t shownAt = 0;

// Work the BLE callbacks hand to loop(): drawing takes seconds, the BLE task mustn't wait.
static volatile bool wantStore = false, wantClear = false, wantInfo = false, wantMode = false;
static volatile int wantShow = -1;

static void say(const char *s) {
  tx->setValue((const uint8_t *)s, strlen(s));
  tx->notify();
}

static String slotPath(int s) { return String("/s") + s + ".pb"; }
static bool hasSlot(int s) { return LittleFS.exists(slotPath(s)); }

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

static void draw() {
  epd_poweron();
  epd_clear();
  epd_draw_grayscale_image(epd_full_screen(), frame);
  epd_poweroff();
}

/** Put a stored slot on the panel. The packed buffer is free unless a frame is arriving. */
static bool showSlot(int s) {
  if (packedLen) return false;                       // mid-transfer: not now
  File f = LittleFS.open(slotPath(s), "r");
  if (!f) return false;
  size_t n = f.read(packed, MAX_PACKED);
  f.close();
  if (!unpack(packed, n, frame, FRAME_BYTES)) return false;
  draw();
  showing = s;
  shownAt = millis();
  return true;
}

/** Table mode's order: login, then each stored portrait, around again. */
static int nextSlide(int from) {
  if (from < FIRST_GUEST || from > LAST_GUEST) from = FIRST_GUEST - 1;
  for (int s = from + 1; s <= LAST_GUEST; s++) if (hasSlot(s)) return s;
  return 0;
}

static void saveSettings() {
  File f = LittleFS.open("/mode", "w");
  if (f) { f.write(mode); f.write((uint8_t *)&hold, 2); f.write(nextGuest); f.close(); }
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
        packedSlot = n >= 6 ? d[5] : 0;
        packedGot = 0;
        if (packedLen == 0 || packedLen > MAX_PACKED) { packedLen = 0; return say("ERR size"); }
        if (packedSlot != 255 && packedSlot >= SLOTS) { packedLen = 0; return say("ERR slot"); }
        say("READY");
        break;
      case 'D':
        if (!packedLen || packedGot + n - 1 > packedLen) return say("ERR overrun");
        memcpy(packed + packedGot, d + 1, n - 1);
        packedGot += n - 1;
        break;
      case 'E':
        if (!packedLen || packedGot != packedLen) return say("ERR incomplete");
        wantStore = true;
        break;
      case 'S':
        if (n < 2 || d[1] >= SLOTS) return say("ERR slot");
        wantShow = d[1];
        break;
      case 'M':
        if (n < 4) return say("ERR short");
        mode = d[1] ? 1 : 0;
        hold = max(10, d[2] | d[3] << 8);
        wantMode = true;
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
  pinMode(KEY_1, INPUT);
  pinMode(KEY_2, INPUT);
  frame = (uint8_t *)ps_malloc(FRAME_BYTES);
  packed = (uint8_t *)ps_malloc(MAX_PACKED);
  if (!frame || !packed) {
    Serial.println("badge: no PSRAM (Tools > PSRAM: Enabled)");
    while (true) delay(1000);
  }
  memset(frame, 0xFF, FRAME_BYTES);
  epd_init();

  if (LittleFS.begin(true)) {
    File f = LittleFS.open("/mode", "r");
    if (f) {
      mode = f.read() ? 1 : 0;
      f.read((uint8_t *)&hold, 2);
      int g = f.read();
      if (g >= FIRST_GUEST && g <= LAST_GUEST) nextGuest = g;
      f.close();
    }
    // The panel keeps its picture with the power off, but redraw the login QR in case it
    // was wiped (e.g. after flashing).
    showSlot(0);
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
  if (wantStore) {
    wantStore = false;
    size_t n = packedLen;
    int slot = packedSlot;
    if (slot == 255) {                   // a new guest portrait: over the oldest one
      slot = nextGuest;
      nextGuest = nextGuest + 1 > LAST_GUEST ? FIRST_GUEST : nextGuest + 1;
      saveSettings();
    }
    if (!unpack(packed, n, frame, FRAME_BYTES)) {
      packedLen = 0;
      say("ERR unpack");
    } else {
      File f = LittleFS.open(slotPath(slot), "w");
      if (f) { f.write(packed, n); f.close(); }
      packedLen = 0;
      draw();                            // whatever was just sent goes up straight away
      showing = slot;
      shownAt = millis();
      say("OK");
    }
  }
  if (wantShow >= 0) {
    int s = wantShow;
    wantShow = -1;
    say(showSlot(s) ? "OK" : "ERR empty");
  }
  if (wantMode) {
    wantMode = false;
    saveSettings();
    shownAt = millis();
    say("OK");
  }
  if (wantClear) {
    wantClear = false;
    memset(frame, 0xFF, FRAME_BYTES);
    epd_poweron();
    epd_clear();
    epd_poweroff();
    showing = -1;
    say("OK");
  }
  if (wantInfo) {
    wantInfo = false;
    epd_poweron();                       // the battery divider only reads with the panel powered
    delay(10);
    uint32_t mv = analogReadMilliVolts(BATT_PIN) * 2;
    epd_poweroff();
    int bits = 0;
    for (int s = 0; s < SLOTS; s++) if (hasSlot(s)) bits |= 1 << s;
    char s[80];
    snprintf(s, sizeof s, "INFO %d %d %lu %d %d %d %d", EPD_WIDTH, EPD_HEIGHT, (unsigned long)mv, bits, mode, hold, showing);
    say(s);
  }

  // The keys (active low; debounced by only acting on a fresh press).
  static bool k1Was = true, k2Was = true;
  bool k1 = digitalRead(KEY_1), k2 = digitalRead(KEY_2);
  if (!k1 && k1Was) showSlot(showing == 0 && hasSlot(1) ? 1 : 0);
  if (!k2 && k2Was) {
    int s = nextSlide(showing);
    if (s == 0) s = nextSlide(0);        // KEY 2 is for portraits: skip the login QR
    if (s) showSlot(s);
  }
  k1Was = k1;
  k2Was = k2;

  // Timing: WORN puts the login QR back after a portrait; TABLE moves the slideshow on.
  // An invite stays until the deck takes it down.
  if (showing >= 0 && showing != INVITE_SLOT && millis() - shownAt > (uint32_t)hold * 1000) {
    if (mode == 0 && showing >= FIRST_GUEST && showing <= LAST_GUEST) showSlot(0);
    else if (mode == 1) {
      int s = nextSlide(showing);
      if (s != showing) showSlot(s);
      else shownAt = millis();
    }
  }
  delay(20);
}
