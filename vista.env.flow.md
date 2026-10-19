# Vista: Flow การโหลด Environment และเลือก Model / API Key

เอกสารนี้สรุปลำดับตั้งแต่โหลด environment จนเลือก provider, model และ API key โดยไม่แสดงค่าคีย์จริง รายละเอียดเพิ่มเติมอยู่ใน [Configuration](packages/docs/content/docs/configuration.mdx#configuration-flow-and-precedence)

## 1. ภาพรวม

```text
Shell / service manager / container environment
  + Next.js โหลด .env* โดยค่าที่มีอยู่ใน process.env ชนะ
  -> process.env
  -> Deployment model configuration
       OPENMAIC_CONFIG หรือ openmaic.yml
       หรือ legacy configuration เมื่อไม่มี YAML ใหม่
  + Workspace Settings จากฐานข้อมูลของ owner
  -> ตรวจ lock และ allowUserKeys
  -> เลือก slot และ model assignment
  -> เลือก provider / endpoint / credentials และตรวจ authorization
  -> เรียก adapter ของ chat, TTS, image หรือ capability ที่ร้องขอ
```

**การเลือก model กับการเลือก key เป็นคนละขั้นตอน** การมี key ไม่ได้เลือก model ให้อัตโนมัติ และการเปลี่ยน `DEFAULT_MODEL` ไม่ได้ล้างค่าที่ workspace เคยบันทึกไว้

## 2. Next.js โหลด Environment ตามลำดับใด

แต่ละตัวแปรใช้ค่าแรกที่พบจากลำดับต่อไปนี้:

| ลำดับ | แหล่งค่า | หมายเหตุ |
| --- | --- | --- |
| 1 | `process.env` ที่มีอยู่แล้ว | จาก shell, service manager หรือ container รวมถึงค่าที่เป็น empty string |
| 2 | `.env.<mode>.local` | เช่น `.env.development.local` หรือ `.env.test.local` |
| 3 | `.env.local` | ไม่โหลดในโหมด `test` |
| 4 | `.env.<mode>` | `development`, `production` หรือ `test` |
| 5 | `.env` | ค่าเริ่มต้นร่วม |

เมื่อไม่ได้ตั้ง `NODE_ENV`, `next dev` ใช้ `development` ส่วน `next build` และ `next start` ใช้ `production` ไฟล์ env อยู่ที่ app root ไม่ใช่ directory ของแต่ละ route

Next.js ขยาย `$VAR` และ `${VAR}` ในไฟล์ env; ใช้ `\$` เมื่อต้องการ dollar sign จริง ส่วน script ทั่วไปไม่ได้โหลด `.env.local` อัตโนมัติเพียงเพราะอ่าน `process.env`

## 3. เลือก Deployment Configuration

### มี `OPENMAIC_CONFIG` หรือ `openmaic.yml`

- ถ้าตั้ง `OPENMAIC_CONFIG` ใช้ path นั้น และไฟล์ต้องมีอยู่จริง
- ถ้าไม่ตั้ง จะหา `openmaic.yml` ใน working directory ของ server
- YAML ใหม่แทน legacy model configuration ไม่ใช่ merge ทุกแหล่งเข้าด้วยกัน
- Environment ใช้เติมเฉพาะ `${VAR}` ที่ YAML อ้างอิง; `DEFAULT_MODEL` ไม่ได้ override `slots.llm` ใน YAML ใหม่
- Legacy provider force-disable switches ยังมีผลตามเงื่อนไขใน [Migration](packages/docs/content/docs/configuration.mdx#migrating-from-the-legacy-configuration)

### ไม่มี YAML ใหม่: Legacy Configuration

```text
server-providers.yml เป็นฐาน
  -> environment ที่ไม่ว่าง override ราย field ของ provider
     เช่น *_API_KEY, *_BASE_URL และ *_MODELS
  -> แปลง provider และ DEFAULT_MODEL / MODEL_FALLBACK เป็น deployment slots
```

กฎ “env override YAML” ข้างต้นหมายถึง **legacy `server-providers.yml`** ไม่ใช่การ override ทุก field ของ `openmaic.yml` ส่วน `MODEL_ROUTES` ถูกยกเลิกและปฏิเสธใน flow ปัจจุบัน

Deployment model configuration ถูก cache ต่ออายุ process จึงต้อง restart หลังเปลี่ยน env/provider/YAML อย่าถือว่า dev hot reload จะล้าง model config cache เสมอไป

## 4. Workspace, Lock และแหล่ง API Key

| ประเด็น | กฎ |
| --- | --- |
| Slot ที่ถูก lock | ใช้ deployment assignment เท่านั้น รวมลูกใน subtree |
| Slot ที่ไม่ lock | หา workspace assignment จาก slot ขึ้นไปยัง capability root ก่อน แล้วจึงหา deployment default |
| Assignment เป็น `null` | หยุดการไล่หาค่านั้นและปิด capability |
| Provider ID ซ้ำกัน | Deployment provider ชนะ workspace provider รวม credentials และ endpoint โดยไม่ merge keys |
| `allowUserKeys: false` | ไม่ใช้ workspace-owned providers |
| Workspace keys | เก็บเข้ารหัสใน PostgreSQL และถอดรหัสฝั่ง server |
| `OPENMAIC_SECRET_KEY` | กุญแจเข้ารหัสข้อมูล ไม่ใช่ API key สำหรับเรียก provider |

ดังนั้น keys อาจมาจาก environment ของ process, YAML provider fields หรือ Workspace Settings ใน DB ไม่จำกัดแค่ `.env.local` การแก้ Workspace Settings มีผลในการ resolve โดยไม่ต้อง restart server

Legacy API request fields เช่น `x-model` และ `x-api-key` ยังมีเงื่อนไข compatibility ของตนเอง ไม่สามารถใช้ override lock หรือ server-managed credentials ได้โดยพลการ ดู [Deprecated request fields](packages/docs/content/docs/configuration.mdx#api-clients-and-deprecated-request-fields)

## 5. Chat และ TTS ไม่ใช่ Slot เดียวกัน

- Legacy `DEFAULT_MODEL` ตั้งค่า chat root `llm`
- `tts` เป็น capability แยก มี assignment, provider และ credentials ของตัวเอง
- ตั้ง chat เป็น mittr จึงไม่ได้แปลว่าเสียงต้องใช้ mittr หรือปิด OpenRouter แล้ว
- Fallback ของ chat ต้องถูกกำหนดไว้ ไม่ใช่การสุ่มเปลี่ยน provider

## 6. Docker และ Build-time Configuration

สำหรับ `docker-compose.yml` หลักของ repository:

```text
service env_file:
  docker-compose.defaults.env
  .env.local                 <- override matching defaults
service environment          <- override env_file ทั้งสอง
  -> container process.env   <- ชนะ Next.js .env* loading
```

Compose interpolation ของ ports/build args ใช้ shell หรือ Compose `.env` หรือ CLI `--env-file` ไม่ใช่ service `env_file` โดยอัตโนมัติ

`NEXT_PUBLIC_*` ถูกฝังใน client bundle ตอน build ต้องส่งค่าผ่าน build args ที่รองรับและ rebuild; เปลี่ยน runtime env อย่างเดียวไม่ได้เปลี่ยน client bundle

ไฟล์ Compose อื่น เช่น `vista.app.yml` อาจมีรายการ env files, mounts และ environment ต่างกัน ต้องตรวจไฟล์ที่ใช้ deploy จริง ไม่ควรนำลำดับของ Compose หลักไปเหมารวม ดู [Hosting](packages/docs/content/docs/hosting.mdx#docker-compose-as-a-personal-installation) และ [Deployment](packages/docs/content/docs/deployment.mdx#docker)

## 7. ตรวจกรณีตั้ง Mittr แต่ยังเรียก OpenRouter

1. ระบุ server/worker ที่เรียกจริง เพราะหลายเครื่องอาจใช้ฐานข้อมูลเดียวกันแต่มี env หรือ version ต่างกัน
2. ตรวจ environment ของ process และ restart ล่าสุด ไม่ดูเฉพาะ `.env.local` บนเครื่องปัจจุบัน
3. ตรวจ `OPENMAIC_CONFIG` และ `openmaic.yml` ว่าแทน legacy defaults อยู่หรือไม่
4. ตรวจ slot ที่ล้ม เช่น `course.content` หรือ `tts` รวม workspace assignment, ancestors และ lock
5. ตรวจ provider ID, endpoint และ fallback โดยไม่แสดง API key
6. แยก quota/credit ของ provider ออกจากข้อผิดพลาดด้าน configuration; Retry ไม่ได้แก้ quota ที่หมด

อย่าพิมพ์ keys, Authorization headers หรือ `DATABASE_URL` ที่มีรหัสผ่านลง logs หรือเอกสาร และอย่าสรุปแหล่ง key ของงานใดจากค่า `DEFAULT_MODEL` เพียงค่าเดียว

## 8. ตัวอย่างเปลี่ยนไปใช้ Provider อื่น

ตัวอย่างต่อไปนี้เป็นทางเลือก ไม่ควรนำสองรูปแบบมาผสมโดยคาดว่า legacy env จะ override YAML ใหม่ คีย์และ model ID ต้องตรงกับสิทธิ์ของบัญชีจริง ตัวอย่างไม่ได้เปลี่ยน `DATABASE_URL` หรือเรียก provider ให้อัตโนมัติ

### แบบ Legacy: เปลี่ยน Chat ไป Anthropic ผ่าน Env

ใช้เฉพาะ deployment ที่ไม่มี `openmaic.yml` และไม่ได้ตั้ง `OPENMAIC_CONFIG` ตัวอย่างส่วนที่เกี่ยวข้องใน `.env.local`:

```dotenv
ANTHROPIC_API_KEY=REPLACE_WITH_YOUR_OWN_SECRET
ANTHROPIC_MODELS=claude-sonnet-4-6
DEFAULT_MODEL=anthropic:claude-sonnet-4-6
```

- เก็บคีย์จริงใน secret manager หรือไฟล์ที่ไม่ commit; placeholder ข้างต้นใช้เรียกจริงไม่ได้
- `ANTHROPIC_MODELS` เป็นรายการโมเดลที่อนุญาต ไม่ใช่ตัวเลือกโมเดลที่จะใช้งาน ส่วน `DEFAULT_MODEL` เป็น deployment default ของ `llm`
- หากมี `MODEL_FALLBACK` เดิม ให้ตรวจและนำออกเมื่อต้องการทดสอบโดยไม่มี fallback ไป provider อื่น
- Restart server แล้วตรวจ effective slots ตามหัวข้อ 9; workspace assignment เดิมอาจยังชนะ default นี้
- ตัวอย่างนี้ไม่เปลี่ยน `tts` หากต้องการเสียง ให้ตั้งค่าและตรวจ slot เสียงแยกต่างหาก

### แบบแนะนำ: Env สำหรับ Secret และ YAML สำหรับ Assignment

ตัวอย่างใช้ Anthropic เช่นกัน แต่กำหนด provider ID เป็น `study` เพื่อแยกจากชื่อ preset ใน `.env.local`:

```dotenv
OPENMAIC_CONFIG=./openmaic.yml
ANTHROPIC_API_KEY=REPLACE_WITH_YOUR_OWN_SECRET
```

จากนั้นตั้ง `openmaic.yml`:

```yaml
providers:
  study:
    preset: anthropic
    apiKey: ${ANTHROPIC_API_KEY}
    models: [claude-sonnet-4-6]

slots:
  llm: study:claude-sonnet-4-6
  tts: null

lock: [llm, tts]
allowUserKeys: false
```

ตัวอย่างนี้ตั้งใจล็อก chat subtree ให้ใช้ `study` และปิดเสียงสำหรับทุก workspace จึงมีผลกว้างกว่าเปลี่ยน default อย่างเดียว หากต้องการให้แต่ละ workspace เลือกเอง ให้นำ `lock` ออกและพิจารณานโยบาย `allowUserKeys` ใหม่ จากนั้นตรวจ workspace overrides ด้วย

เมื่อเลือกแบบ YAML ค่า `DEFAULT_MODEL` เก่าจะไม่ override `slots.llm` นี้ สำหรับ Pro ต้องตรวจ `agent` เพิ่มด้วย: แม้ slot อาจ inherit `llm` ได้ โมเดลต้องรองรับ tool calling และ API ของ agent ที่ deployment ใช้ด้วย

สำหรับ Docker ต้องให้ไฟล์ YAML อยู่ใน container จริงด้วย เช่น mount ไป `/app/openmaic.yml` และให้ `OPENMAIC_CONFIG` ชี้ path ที่ container อ่านได้ ไม่ใช่ path บน host ที่ไม่ได้ mount หลังเปลี่ยน env ต้อง recreate container ด้วย configuration เดิมที่ตั้งใจใช้; restart container อย่างเดียวไม่เปลี่ยน environment ที่ถูก inject ไว้ตอนสร้าง

## 9. ตรวจว่า Runtime Resolve ค่าที่ต้องการจริง

### ตรวจจาก Browser Session เดียวกับงาน

1. Restart/recreate server หรือ worker ทุก replica ที่ใช้กับงานนั้นหลังเปลี่ยน deployment config
2. เปิด Model Settings ด้วยบัญชี/workspace เดียวกับที่สร้างคอร์ส
3. เปิด DevTools → Network แล้วดู response ของ **GET `/api/model-config`** ที่หน้า Settings เรียก หลีกเลี่ยงการแชร์ response ทั้งชุด เพราะมี metadata ของ provider ส่วนตัวได้ แม้ API ไม่ส่ง raw API key กลับมา
4. ตรวจ `slots[]` ของ `llm`, `course.outline`, `course.content`, `course.actions`, `agent` และ `tts` ตามงานที่ใช้ ไม่ดูแค่รายชื่อโมเดลที่เลือกได้

สำหรับตัวอย่าง YAML ด้านบน ค่าที่ควรเห็นคือ:

| Field | ค่าที่คาดหวัง |
| --- | --- |
| Chat slot `effective.status` | `assigned` |
| Chat slot `effective.providerId` | `study` |
| Chat slot `effective.modelId` | `claude-sonnet-4-6` |
| `effective.resolvedAt` | `llm` เมื่อ inherit จาก chat root |
| `locked` | `true` สำหรับ subtree ที่ล็อก |
| `tts.effective.status` | `disabled` |

`assignment` และ `serverDefault` ไม่ใช่หลักฐานสุดท้าย ให้ดู **`effective`** ที่ resolve แล้วด้วย หาก `status` เป็น `invalid` ให้อ่าน `message`; หากเป็น `unassigned` ให้ตรวจ assignment และ ancestors ส่วน `source` และ `effective.source` ช่วยบอกว่าค่าได้จาก workspace, deployment หรือ inheritance

### ตรวจด้วย Curl โดยไม่ใส่ Key ในคำสั่ง

หากมี `curl` และ `jq` และมี cookie jar ของ session ที่ใช้อยู่แล้วในพื้นที่ปลอดภัย สามารถกรองเฉพาะ slot diagnostics ได้ดังนี้ คำสั่งนี้เป็นตัวอย่างเท่านั้น ไม่ได้สร้าง cookie jar หรือเรียกโมเดล:

```bash
curl --fail-with-body --silent --show-error \
  --cookie "/secure/path/existing-session.cookies" \
  "http://localhost:3000/api/model-config" \
  | jq '{revision, allowUserKeys, slots: [.slots[] | {
      slot, locked, source,
      effective: (.effective | {
        status, resolvedAt, source, providerId, providerSource, modelId,
        message,
        fallback: (.fallback | if . == null then null else
          {providerId, providerSource, modelId}
        end)
      })
    }]}'
```

ใช้ GET เท่านั้น; PUT endpoint นี้แก้ Settings อย่านำ cookies หรือ Authorization headers ไปใส่ในเอกสาร/แชต และอย่าสร้างคำสั่งจาก “Copy as cURL” แล้วเผยแพร่โดยไม่ลบ secrets

ถ้าเปิด `ACCESS_CODE` ต้องมี access cookie และยังต้องใช้ owner identity ที่ถูกต้องด้วย Curl ที่ไม่มี session เดียวกับ browser อาจ resolve คนละ workspace หรือสร้าง anonymous identity ใหม่ จึงไม่ใช่หลักฐานของงานเดิม GET นี้ไม่เรียก inference แต่ขั้นตอนยืนยันตัวตนอาจมีผลข้างเคียง เช่น mint/renew cookie หรือ automatic owner claiming ตาม configuration

### Effective Config ไม่เท่ากับเรียก Provider สำเร็จ

- `/api/model-config` แสดงผล resolve สำหรับ workspace และ process ที่ตอบ request นั้น ไม่ยืนยันว่า worker เครื่องอื่นโหลดค่าเดียวกัน
- `/api/health` และ `/api/server-providers` ไม่ใช่หลักฐานว่า slot ของ workspace เลือกโมเดลใดจริง โดยเฉพาะเมื่อใช้ YAML ใหม่
- หากต้องยืนยันการเรียก upstream จริง ให้ทดสอบงานขนาดเล็กหลังอนุมัติค่าใช้จ่าย แล้วเทียบเวลา, run/request ID และ model/provider ใน diagnostics หรือ usage ของ provider โดยไม่เปิดเผย keys และตรวจ fallback ด้วย
- การ resolve ถูกต้องยังไม่รับประกัน key ใช้ได้, quota เพียงพอ, network ติดต่อได้ หรือ model รองรับ capability ที่ต้องการ
