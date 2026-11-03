# Vista Changelog

บันทึกการเปลี่ยนแปลงของ image `ghcr.io/techflowasia/vista-app` แต่ละเวอร์ชัน (เลขเวอร์ชันมาจาก `vista.package.json`) การเปลี่ยนแปลงจาก OpenMAIC upstream ดูรายละเอียดใน [CHANGELOG.md](CHANGELOG.md)

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
