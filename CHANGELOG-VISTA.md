# Vista Changelog

บันทึกการเปลี่ยนแปลงของ image `ghcr.io/techflowasia/vista-app` แต่ละเวอร์ชัน (เลขเวอร์ชันมาจาก `vista.package.json`) การเปลี่ยนแปลงจาก OpenMAIC upstream ดูรายละเอียดใน [CHANGELOG.md](CHANGELOG.md)

## [1.0.4] - 2026-11-09

Build จาก `develop` ที่ `e1e1c641` (บวก commit release นี้ที่แก้แค่เลขเวอร์ชันและ changelog) บน OpenMAIC upstream **v1.4.1** พร้อม fix หลัง 1.4.1 จนถึง #2213

### Upstream

- Widget outline ส่งถึงตัวเขียนหน้าแบบครบ: ตัวแปรที่เป็น object แสดงเป็นข้อความที่อ่านได้ ส่ง design idea ต่อไปด้วย และ field ที่ไม่มีช่องใน prompt ไปอยู่ในหัวข้อ Additional Design Requirements (#2209)
- Library ของ interactive ที่อยู่ใน allowlist แต่ model พิมพ์เลขเวอร์ชันผิด จะ map ไปยัง build ที่ host ไว้แทนที่จะได้ 404 ทั้งตอน render และ export (#2209)
- Range ของ widget แบบ `{ min, max, step }` ส่ง `step` และ constraint อื่นถึงตัวเขียนหน้าแล้ว ก่อนหน้านี้เหลือแค่ min–max (#2210)
- Laser pointer ตอน playback อยู่ตำแหน่งเดียวกับที่เห็นใน editor (#2213)

### Deploy notes

- ไม่มี migration ของฐานข้อมูลและไม่มีค่า env ใหม่ อัปเกรดจาก 1.0.3 ได้ด้วยการเปลี่ยน image อย่างเดียว และสลับกลับไป 1.0.3 ได้

## [1.0.3] - 2026-11-08

Build จาก `develop` ที่ `a0c6a94e` บน OpenMAIC upstream **v1.4.1** (1.0.2 อยู่บน upstream 1.3.1)

### Upstream

- รวม OpenMAIC [1.4.0](CHANGELOG.md#140---2026-11-04) และ [1.4.1](CHANGELOG.md#141---2026-11-05) รวมถึง fix และ feature หลัง 1.4.1 จนถึง #2159 (PR #13)
- **PBL v3** และ **shared sandbox** (experimental): โปรเจกต์เขียนโปรแกรมที่รันได้จริงใน classroom พร้อม IDE, terminal และ AI tutor ปิดอยู่จนกว่าจะตั้ง sandbox provider (`/pbl-v3` ตอบ 404)
- Course-level undo timeline สำหรับการแก้ไขทั้งจากผู้ใช้และ agent (#2159)
- Provider เสียง Xiaomi MiMo TTS และ ASR (`TTS_XIAOMI_*`, `ASR_XIAOMI_*`) (#1976)
- เปลี่ยน Qwen voice cloning ไปใช้ CosyVoice (`cosyvoice-v3.5-plus`) (#1949)
- แก้ปัญหา background sync ทับการแก้ไขที่ยังไม่บันทึกและทำ progress ของ PBL หาย (#2168, #2184) และคอร์สเปิดช้ามากบนเน็ตช้า (#2185)

### Changed

- Merge conflict กับโค้ดของ Vista แก้โดยเก็บทั้งสองฝั่ง: provider registry ของ Vista, generation observability (`attempts`) ใน `lib/ai/llm.ts` และการขอ access code ใน `use-generation-run.ts`
- เพิ่ม Xiaomi TTS/ASR ใน test matrix ของ media provider ของ Vista
- Dockerfile ตั้ง `NODE_OPTIONS=--max-old-space-size=4096` ให้ `pnpm build` เพราะ type check ของ Next.js ใช้ heap เกิน ~2 GiB ที่ V8 ตั้งให้ใน Docker Desktop VM 8 GiB (PR #15, #16)

### Deploy notes

- **อัปเกรดแล้วย้อนกลับไม่ได้**: `@openmaic/storage` 0.39.2 เพิ่ม asset migration v4 ที่รันเองตอนเริ่ม persistence หลังจากนั้น 1.0.2 จะไม่ยอม start กับฐานข้อมูลนี้ (`SchemaVersionAheadError`)
  - Backup ฐานข้อมูลก่อนอัปเกรด ถ้าต้อง rollback ให้ restore ฐานข้อมูล ไม่ใช่แค่สลับ image กลับ
  - หยุด container 1.0.2 ทุกตัวก่อน start 1.0.3 อย่ารันสองเวอร์ชันพร้อมกัน
  - Migration lock ตาราง `document_asset_refs` ระหว่าง validate constraint ตารางใหญ่จะใช้เวลาสักพัก
- ตั้งแต่เวอร์ชันนี้ server เช็ก schema ทุก ~30 วินาที และ replica เก่าจะ exit เมื่อเวอร์ชันใหม่ migrate ฐานข้อมูล
- ถ้าใช้ Qwen voice cloning ต้องเพิ่ม `cosyvoice-v3.5-plus` ใน `TTS_QWEN_MODELS` คู่กับ `qwen3-tts-flash` (เช่น `TTS_QWEN_MODELS=qwen3-tts-flash,cosyvoice-v3.5-plus`) ไม่อย่างนั้นจะได้ HTTP 403 เสียงที่ clone ไว้แบบเดิมต้อง clone ใหม่
- PBL v3 และ sandbox ปิดอยู่ ไม่ต้องตั้งค่าเพิ่ม ถ้าจะเปิดใช้ ดู [PBL v3 guide](lib/pbl/v3/README.md#try-the-sample) และ [sandbox README](lib/server/sandbox/README.md) เมื่อเปิด sandbox แล้วทุก owner ที่เข้าระบบได้จะใช้ sandbox ได้ (รวม anonymous) จึงต้องมี `ACCESS_CODE` หรือระบบ sign-in และตั้ง cap ให้ต่ำ
- ค่า env จาก 1.0.2 ยังใช้ได้เหมือนเดิม Image ยังไม่มี `.env*` และอ่านค่าจาก `.env.local` บนเครื่อง deploy

## [1.0.2] - 2026-11-03

Build จาก `develop` ที่ `49f98630` บน OpenMAIC upstream **v1.3.1** (1.0.1 อยู่บน upstream 1.2.0-rc.2)

### Upstream

- รวม OpenMAIC [1.2.0](CHANGELOG.md#120---2026-10-16), [1.2.1](CHANGELOG.md#121---2026-10-18), [1.3.0](CHANGELOG.md#130---2026-10-29) และ [1.3.1](CHANGELOG.md#131---2026-11-02) รวมถึง fix หลัง 1.3.1: ยอด usage ข้ามหน่วยเมื่อปัดเศษ (#2126) และไม่ตัด emoji ใน prompt ของ PBL evaluator (#2124)

### Added

- เสียงพากย์ผ่าน OpenRouter: model Gemini TTS (`google/*`) และ Kokoro 82M (`hexgrad/*`) ใช้ endpoint `/audio/speech` โดย Gemini แปลง PCM เป็น WAV รวมถึงรองรับ streaming TTS
- Generation run observability: log แต่ละขั้น (research, outline, content, actions, narration) เป็น event `GenerationObservability`
- `vista.app.yml` สำหรับ deploy บน AWS ผ่าน Portainer (network `portainer_default` แบบ external)

### Changed

- จำกัด output tokens ของการสร้างคอร์สผ่าน OpenRouter
- แยกการเริ่ม instrumentation ของ Node.js ออกจาก Edge runtime และแยก config ของ capability provider
- Workspace ใหม่ได้ค่า model ตั้งต้นใหม่ ส่วน workspace เดิมคงค่าที่เลือกไว้

### Fixed

- ทิ้ง action type ที่ model แต่งขึ้นที่ parser ไม่ทำให้ทั้งหน้าล้ม และกลับไปใช้ action ตั้งต้นเมื่อไม่เหลือ action ที่ใช้ได้ (#2137, PR #9)
- Narration ด้วย Gemini TTS ล้มด้วย `cannot be used with the chat/completions endpoint` บน image ก่อนหน้า
- ตรวจ authentication ก่อนเริ่ม generation และรองรับการกู้ run ที่ค้างแบบจำกัดขอบเขต
- กลับไปใช้ model ตั้งต้นของ provider เมื่อหา image model ไม่เจอ

### Deploy notes

- Image ไม่มี `.env*`, `openmaic.yml` หรือ `server-providers*.yml` ค่าทั้งหมดอ่านจาก `.env.local` บนเครื่อง deploy ตอนรัน ต้องอัปเดต model บนเครื่อง prod เอง:
  - `OPENAI_MODELS=mittr-1-0-max,mittr-luna,mittr-1-0` (ชื่อ `mittr-1-0-luna` ไม่มีบน endpoint)
  - `OPENROUTER_MODELS` ใช้ `anthropic/claude-sonnet-5.5` แทน `anthropic/claude-sonnet-4.6`
  - `IMAGE_OPENROUTER_MODELS` ขึ้นต้นด้วย `google/gemini-3.1-flash-lite-image`
  - `WEB_SEARCH_CLAUDE_BASE_URL`, `WEB_SEARCH_CLAUDE_API_KEY`, `WEB_SEARCH_CLAUDE_MODELS` สำหรับ web search
- ค่าที่เก็บในฐานข้อมูล (เปิด Web search, default model ของ workspace) ต้องตั้งใน Course Model Config ของ prod ถ้า prod ใช้ฐานข้อมูลคนละตัว
- ไม่มีการเปลี่ยน storage schema ที่ต้อง migrate เอง
- `/api/health` ใน container แสดง `version: 0.1.0` เพราะ `node server.js` ไม่ได้ตั้ง `npm_package_version`

## [1.0.1] - 2026-10-12

เวอร์ชันแรกที่ push ขึ้น GHCR บน OpenMAIC upstream 1.2.0-rc.2 (ไม่มีบันทึกรายละเอียด)
