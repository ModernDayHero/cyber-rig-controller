# Build (and optionally flash) the badge firmware with arduino-cli.
#   .\build.ps1                 compile
#   .\build.ps1 -Port COM9      compile, then flash the T5 on COM9
#
# LilyGo-EPD47 needs the ESP32 Arduino core 2.0.x (below 3.0), so this uses its own
# Arduino setup in C:\crb (a short path: the 2.0.x compiler loses files on long ones),
# leaving any other Arduino install and its newer ESP32 core alone. First run downloads
# the core (~400 MB) and the two libraries.
param([string]$Port)
$ErrorActionPreference = 'Stop'
$root = 'C:\crb'
$env:ARDUINO_DIRECTORIES_DATA = "$root\data"
$env:ARDUINO_DIRECTORIES_USER = "$root\user"
$env:ARDUINO_DIRECTORIES_DOWNLOADS = "$root\downloads"
$env:ARDUINO_BOARD_MANAGER_ADDITIONAL_URLS = 'https://espressif.github.io/arduino-esp32/package_esp32_index.json'
$fqbn = 'esp32:esp32:esp32:PSRAM=enabled,PartitionScheme=huge_app'

if (-not (Test-Path "$root\data\packages\esp32\hardware\esp32\2.0.17")) {
  arduino-cli core update-index
  arduino-cli core install esp32:esp32@2.0.17
}
if (-not (Test-Path "$root\user\libraries\NimBLE-Arduino")) { arduino-cli lib install NimBLE-Arduino }
if (-not (Test-Path "$root\user\libraries\LilyGo-EPD47")) {
  git clone --depth 1 https://github.com/Xinyuan-LilyGO/LilyGo-EPD47.git "$root\user\libraries\LilyGo-EPD47"
}

arduino-cli compile --fqbn $fqbn --output-dir "$root\build" "$PSScriptRoot\badge"
if ($Port) { arduino-cli upload -p $Port --fqbn $fqbn --input-dir "$root\build" "$PSScriptRoot\badge" }
