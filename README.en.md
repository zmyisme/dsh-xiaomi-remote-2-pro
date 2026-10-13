# dsh-xiaomi-remote-2-pro

[![test](https://github.com/zmyisme/dsh-xiaomi-remote-2-pro/actions/workflows/ci.yml/badge.svg)](https://github.com/zmyisme/dsh-xiaomi-remote-2-pro/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

> Turn the **Xiaomi Bluetooth Remote 2 Pro (RC003)** into a push-to-talk voice input and a
> one-key shortcut console **inside DeepSeek Harness**.
> A ~$6 Bluetooth remote, one DSH plugin, zero native dependencies, zero admin rights, offline recognition.

**中文文档见 [README.md](README.md)。**

---

## What it is

A **DSH plugin** (not a standalone app). Once installed:

- **The remote's voice key becomes push-to-talk.** Hold → DSH starts recording. Release → speech is
  transcribed → the text lands in the active session's composer. Press OK to send.
- **The remote becomes a programmable shortcut keyboard.** Four gestures
  (tap / double-tap / long-press / hold) × 13 actionable kinds (insert text, send prompt, submit,
  newline, clear, scroll, send a key chord, toggle panel, log, plus two opt-in host actions), with
  `none` available to explicitly disable a key.
- **Configuration lives in the DSH UI.** A full mapping editor in Settings, plus a floating quick
  panel (toggleable from the remote) showing live status and the last raw key code.
- **The agent can read and rewrite the config.** A `remote_2_pro` tool and a `/remote2pro` command
  are registered.

Transcription **reuses DSH's own speech input**. With the local SenseVoice recogniser selected, audio
never leaves the machine and needs no API key. This plugin itself makes no network requests — if you
switch DSH's recogniser to a cloud provider, audio travels over DSH's existing cloud path, exactly as
for normal voice input.

Unlike standalone tools such as [vibe-flow / Vibe Link](https://github.com/richlearntodo-debug/vibe-flow),
this plugin does not manage audio devices, drive an IME, or install a virtual cable. It does exactly one
thing: **wire the remote into DSH**.

---

## Features

| Feature | Notes |
| --- | --- |
| Push-to-talk | Hold the remote's voice key (= `F5` on Windows), release to transcribe and insert at the caret |
| Four gestures | tap / double-tap / long-press / hold, configurable per key |
| Thirteen actionable kinds | insert text, send prompt, submit, newline, clear, scroll, key chord, toggle panel, log + two opt-in host actions (HTTP, exec); plus `none` to disable a key |
| Three presets | `vibe-coding`, `navigation` (pass-through), `dictation` |
| Learn mode | Bind any unrecognised key (e.g. the TV/input key) by pressing it once |
| Live key codes | The panel and Settings show the **raw key code** received, so you can tell whether Windows dropped a key |
| Floating quick panel | Device status, recogniser status, last key, one-key push-to-talk, pause capture |
| Persistent config | Changes are written back to the profile; if `configEditor` is unavailable the UI says so explicitly |
| Agent-readable | `remote_2_pro` tool: status / get_config / set_config / set_preset / set_mapping / clear_mapping / recent_log |
| Zero native dependencies | Pure JavaScript. No compiler, no admin rights, no drivers, no system changes |

---

## How it works

```
Xiaomi Bluetooth Remote 2 Pro (RC003, BLE HID / HOGP keyboard collection)
        │ standard HID keyboard reports
        ▼
Windows Bluetooth HID stack (mshidumdf / kbdhid.sys)
        │ usages it can translate → normal key events
        │ 0x80 / 0x81 / 0xF1      → dropped, never reach user mode
        ▼
DSH web UI (client half)
  keydown / keyup (capture phase)
    → normalise key code to a logical remote key
    → gesture recognition (tap / double-tap / long-press / hold)
    → action execution
        ├── write to composer / scroll / submit
        └── POST /dsh-remote2pro/api/*

Host half (Node): config persistence, PnP probing, log ring buffer, Tool, command
        └── speechController.transcribe → DSH local SenseVoice

Voice chain: system default microphone → getUserMedia → MediaRecorder
             → decode → resample to 16 kHz mono → canonical WAV
             → base64 → POST /api/transcribe → text → composer
```

**Why are capture and recording in the browser half?** On Windows the remote is just a BLE HID
keyboard, so its keys arrive as ordinary key events on the page, and the microphone is just the system
default recording device. That means the plugin needs no C++ addon, no compilation toolchain, no Electron
ABI matching, no admin rights, and it **completely sidesteps** the layer where Windows drops the
`0x80 / 0x81 / 0xF1` HID usages.

The trade-off: key capture requires the DSH window to be focused — which is exactly what you want when
dictating into the composer.

---

## Install

Requirements: Windows 10/11 x64, DSH desktop or `dsh web`, and the RC003 remote.

1. **Pair the remote in Windows**: Settings → Bluetooth & devices → Add device → Bluetooth →
   hold **Home + Menu** on the remote for ~3s → pick `MI RC` / `Xiaomi Bluetooth Remote 2 Pro`.
2. **(Recommended) Enable DSH's voice input**: Settings → Plugins → enable the experimental voice input
   bundle. The plugin's Settings page has a "pre-download / load recognition model" button.
3. **Install the plugin**:

   ```powershell
   dsh plugin --profile desktop add github:zmyisme/dsh-xiaomi-remote-2-pro
   # or, for dsh web
   dsh plugin --profile web add github:zmyisme/dsh-xiaomi-remote-2-pro
   # or, for local development
   dsh plugin --profile desktop add link:D:\path\to\dsh-xiaomi-remote-2-pro
   ```

4. **Fully restart DSH.** ⚠️ Not a page refresh — the `dsh.client` scan is startup-only.

Then open Settings → **小米遥控器 2 Pro** (Xiaomi Remote 2 Pro) and press a D-pad key; the device badge
should flip to "active".

---

## Default mapping (`vibe-coding` preset)

| Key | Gesture | Action |
| --- | --- | --- |
| Voice | hold / release | push-to-talk (insert at caret) |
| Voice | tap | toggle floating panel |
| OK | tap | submit current draft |
| D-pad up / down | tap | scroll the transcript ±320px |
| D-pad left / right | tap | jump to top / bottom |
| Home | tap | toggle floating panel |
| Menu | tap | insert a newline (no send) |
| TV / Input | tap | insert a canned coding instruction |
| Back, Vol+, Vol−, Mute | — | **unmapped** — Windows drops these keys |

### Why are Back and Volume unmapped?

Because those keys never reach user mode on Windows. They are reported on the HID Keyboard page
(usage page `0x07`) as `0xF1` / `0x80` / `0x81`. Windows' in-box Bluetooth keyboard driver
`kbdhid.sys` only synthesises input for usages it can translate to a scan code / virtual key, so these
are discarded **before any user-mode API sees them**: no low-level keyboard hook, no Raw Input, and
certainly no page events.

There is no bypass either: keyboard-class HID top-level collections are **exclusive** on Windows
(`CreateFile` → `ERROR_ACCESS_DENIED`); the HOGP GATT characteristics are owned by the Windows HID stack
(read → `AccessDenied`); the Xiaomi private service `8a7a0001-…` accepts subscriptions but emits nothing
on key presses; and force-disabling the HID child leaves Windows in a reboot-pending state because it
classifies the keyboard child as critical.

So this plugin ships **no mapping that looks usable but can never fire**. These keys are labelled
"dropped by the system" in the panel, with the reasoning and alternatives documented in Settings.

Recovering them requires either a per-device kernel filter that rewrites `report[3]` (needs test signing
with Secure Boot off, or Microsoft attestation signing) or an elevated helper that injects into the WDF
host and strips the usage bytes (needs a per-run authorization prompt and relies on undocumented internal
semantics). This plugin does neither, because either path stops being "just install a plugin".

---

## Configuration

Everything is edited in Settings → Xiaomi Remote 2 Pro, applied immediately, and written back to the
profile.

- `enabled`, `preset`
- `capture`: `enabled`, `onlyWhenPanelOpen`, `skipWhileTyping`, `preventDefault`, `doubleTapMs`, `longPressMs`
  - `preventDefault` matters: the voice key is `F5`, so without it you would reload the page.
- `voice`: `language`, `providerId`, `autoSubmit`, `insertMode` (`composer` / `clipboard` / `off`),
  `maxSeconds`, `shortcut`, `sampleRate`
- `mappings`: `logicalKey → gesture → action`
- `learnedCodes`: extra `KeyboardEvent.code → logicalKey` bindings from learn mode
- `advanced`: `allowHttp`, `allowExec`, `execAllowlist`, `logLimit`, `deviceProbe`
  - `exec` deliberately does **not** use a shell: the command is split on whitespace and run via
    `execFile(program, args)`. Pipes, redirection and `&&` are unsupported by design.
- `ui`: `showIndicator`, `showKeyLog`, `panelOpenByDefault`

Environment: `DSH_REMOTE2PRO_TRUSTED_HOSTS` (comma-separated) allows non-loopback hosts. The API is
loopback-and-same-origin only by default and rejects `Sec-Fetch-Site: cross-site`.

See the [Chinese README](README.md) for the full tables.

---

## Known limitations

Please read these — they define what this plugin is *not* for.

1. **DSH must stay in the foreground.** Capture relies on page key events. When DSH is in the
   background the remote is just a keyboard typing into whatever window is active. This cannot be used
   to drive DSH from the background.
2. **The remote cannot be distinguished from your physical keyboard.** Browsers expose no device
   identity, so once the voice key is bound to `F5`, your **physical F5 also starts recording**. We
   mitigate with `skipWhileTyping` and idempotent default actions, but it is a real trade-off. If you
   use F5, rebind `voice` or trigger recording from the panel button / shortcut.
3. **Back, Vol+, Vol−, Mute are unreachable** on Windows (see above).
4. **v0.1 records from the PC microphone, not the remote's microphone.** The remote's mic is not a
   Windows audio endpoint; it uses the ATVV (Android TV Voice-over-BLE) private GATT channel. See the
   roadmap.
5. **Inserting text uses the DOM.** DSH exposes no public "write to composer" client service yet, so
   insertion finds the visible composer and writes via the native value setter / `execCommand` plus an
   `input` event. This works with React controlled inputs but depends on the UI structure, so a DSH
   front-end redesign can break it. Failure is explicit: the text is copied to the clipboard with a
   prompt instead of failing silently. Set `voice.insertMode` to `clipboard` if you prefer.
6. **The log ring buffer's capacity is fixed at plugin load**; changing `logLimit` needs a reload.
7. **Gestures have inherent latency**: on a key that also has a double-tap binding, a single tap is
   resolved one `doubleTapMs` window later (280ms default). Single-tap-only keys have no delay.
8. **`exec` has no shell syntax** — intentional.
9. **Windows only.** Key/voice paths are portable but have not been verified elsewhere, so no support is claimed.
10. **First speech use downloads a local model** (a few hundred MB depending on the recogniser); use the warm-up button.

---

## Development

```
host.js               host half: HTTP API, config persistence, device probing, Tool, command
client.js             client half: Lane 1 Module Loader package (keys, gestures, voice, UI)
lib/keys.js           RC003 key model, HID usage table, key normalisation, chord parsing
lib/mapping.js        action catalogue + gesture engine (pure, time injected)
lib/config.js         defaults, presets, tolerant normalisation, Standard Schema
lib/wav.js            WAV encode/decode, resampling, pre-transcription validation (shared)
lib/fence.js          route helpers + trust fence (loopback / same-origin / Sec-Fetch-Site)
lib/device.js         PnP probing via PowerShell EncodedCommand, cached
lib/runtime.js        log ring buffer, speech bridge, config store, runtime stats
test/                 139 cases, run with `node --test`, no install required
```

```powershell
node --test
node --check host.js; node --check client.js
```

Tests are **dependency-free** — no `npm install`, no build step; Node's built-in runner does it all.
They cover every gesture combination and boundary, the minimum usable configuration for all 13 action
kinds, config degradation paths, WAV edge cases, trust-fence bypass attempts, device-probe failure
modes, every host route and Tool action, and a **`vm`-based load of `client.js`** that proves it
registers three slots, installs key listeners, and drives one key press through the whole key-code →
gesture → action chain.

### Local development loop

DSH resolves plugins by package name, and package-manager specs handle spaces in paths poorly. If your
checkout path contains a space, bridge it with a junction first:

```powershell
New-Item -ItemType Junction `
  -Path "C:\Users\<you>\.dsh\plugins\dsh-xiaomi-remote-2-pro" `
  -Target "D:\path\to\dsh-xiaomi-remote-2-pro"

dsh plugin --profile desktop add link:C:\Users\<you>\.dsh\plugins\dsh-xiaomi-remote-2-pro
```

**Any code change requires a full DSH process restart** — a page refresh is not enough. This is a
measured conclusion, not caution:

- `client.js` lives on the browser side and the `dsh.client` scan runs only at startup;
- **`host.js` and `lib/*` need the restart too.** Disabling and re-enabling the bundle in a running DSH
  does re-run `apply()` (and routes are disposed and re-registered cleanly), but **Node's ES module cache
  does not invalidate**, so you keep executing the old code. Check the `version` field in
  `remote_2_pro`'s `status` output or in `/api/state` to see which build is actually running.

Design rules: pure logic separated from side effects; **zero runtime dependencies**; tolerant
configuration (invalid input degrades with a warning, never fails plugin activation); and **no silent
failures**.

---

## Roadmap

1. **ATVV voice path** — capture the remote's own microphone so you can talk from across the room.
   Reconnaissance is done: service `ab5e0001-5a21-4f05-bc7d-af01f617b664` with `ab5e0002` (write),
   `ab5e0003` (audio notify) and `ab5e0004` (control notify); handshake `0A 01 00 00 03 03` → `0C 00`;
   audio is **headerless, high-nibble-first IMA/DVI ADPCM, 120-byte frames, 16 kHz mono**, with decoder
   state continuous across frames. Remaining work: a WinRT BLE transport and feeding PCM to DSH's recogniser.
2. **Optional global capture** — a native helper using Raw Input + `RIDEV_INPUTSINK`, bound to the
   `VID_2717&PID_32B8` device instance, so the remote can finally be told apart from the physical keyboard.
3. **Per-session mappings** — swap button schemes per session/profile.
4. **Export / share configs** — one-click JSON export of a mapping scheme.
5. **More remotes** — key tables for ARN9, T1, Hanvon V60 and similar BLE HID remotes.

---

## Credits

The hardware facts in this plugin rest on measurements published by other projects, each written in a
completely different stack (Rust / Python / C# / Swift / ESP32 firmware) yet arriving at the same
conclusions about which keys are reachable:

- [richlearntodo-debug/vibe-flow](https://github.com/richlearntodo-debug/vibe-flow) — the inspiration, and a complete record of diagnosing and then declining to fake the three dropped keys
- [ZSTDJan/windows-remote-mic-app](https://github.com/ZSTDJan/windows-remote-mic-app) — the production key-usage table that anchors our defaults
- [QL-4/RemoteMapper](https://github.com/QL-4/RemoteMapper) — kernel-level diagnostics confirming the HID report layout
- [GetSayAll/remote-mic-app-windows](https://github.com/GetSayAll/remote-mic-app-windows) — measured HID exclusive-access data and Raw Input engineering detail
- [cuicui-V5/RemoteMapper-ESP32](https://github.com/cuicui-V5/RemoteMapper-ESP32) — ATVV state machine and HOGP report format notes
- [nijez/open-voice-bridge](https://github.com/nijez/open-voice-bridge) — device identity profile (Bluetooth names, VID/PID)
- [xxb26553663-star/remote-bridge-hub](https://github.com/xxb26553663-star/remote-bridge-hub), [mwlt/Voice_VibeCoding](https://github.com/mwlt/Voice_VibeCoding) — ATVV and audio-routing cross-checks

The DSH plugin shape follows two real third-party plugins: `dsh-effort-switcher` (a complete Lane 1
client-half example) and `dsh-whale-widget` (web-route and trust-fence engineering).

## License

[MIT](LICENSE)
