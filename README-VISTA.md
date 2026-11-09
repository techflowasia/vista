# Vista Image

คำสั่ง build และ push image ของ `vista-app` กำหนดไว้ใน `vista.package.json` โดยใช้ค่า `version` เป็น tag ของ image บน GitHub Container Registry (GHCR)

## เปลี่ยนเวอร์ชัน

แก้ค่า `version` ใน `vista.package.json` เป็นเวอร์ชันใหม่ก่อน build หรือ push เช่น:

```json
{
  "version": "1.0.2"
}
```

เลือก tag ใหม่ทุกครั้งที่ต้องการปล่อย image เวอร์ชันใหม่ เพื่อไม่ให้ image เก่าถูกเขียนทับ

ทุกครั้งที่ออกเวอร์ชันใหม่ ให้แก้ให้ตรงกันใน:

- `vista.package.json` → `version`
- `vista.app.yml` และ `vista.yml` → `image: ghcr.io/techflowasia/vista-app:<version>`
- [CHANGELOG-VISTA.md](CHANGELOG-VISTA.md) → เพิ่มหัวข้อเวอร์ชันใหม่พร้อมการเปลี่ยนแปลงและ deploy notes

## Build image

สั่ง build image สำหรับ architecture ปัจจุบัน:

```bash
node run.mjs vista:build
```

script `vista:*` อยู่ใน `vista.package.json` จึงต้องสั่งผ่าน `node run.mjs` (`pnpm run vista:build` จะขึ้น `Missing script`)

คำสั่งจะ tag image เป็น `ghcr.io/techflowasia/vista-app:<version>` ตาม `version` ใน `vista.package.json` และโหลดเข้า local Docker image store

## Push multi-platform image

ต้องติดตั้งและเปิดใช้ Docker Buildx พร้อม builder ที่รองรับ multi-platform build และ login เข้า GHCR ก่อน:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-username> --password-stdin
```

ใช้ GitHub token ที่มีสิทธิ์เขียน package (`write:packages`) แล้ว push สำหรับ `linux/amd64` และ `linux/arm64`:

```bash
node run.mjs vista:push
```

`docker login` ผ่านได้แม้ token ไม่มี `write:packages` แต่ push จะล้มด้วย `permission_denied: The token provided does not match expected scopes` ถ้าใช้ token ของ `gh` ให้เพิ่ม scope ก่อนด้วย `gh auth refresh -h github.com -s write:packages` แล้วตรวจด้วย `gh auth status`

Image จะถูก push เป็น `ghcr.io/techflowasia/vista-app:<version>` โดย `<version>` มาจาก `vista.package.json` เช่น `1.0.2`

`vista:push` build ทีละ platform เพื่อให้พอกับ memory ของ Docker Desktop VM 8 GiB: build และ push `linux/arm64` เป็น tag `<version>-arm64` ก่อน ตามด้วย `linux/amd64` เป็น `<version>-amd64` แล้วรวมเป็น `<version>` ด้วย `docker buildx imagetools create` ถ้า build ทั้งสอง platform พร้อมกัน (`--platform linux/arm64,linux/amd64`) `pnpm build` จะถูก kill ด้วย `cannot allocate memory` Tag `-arm64` และ `-amd64` ชี้ไปที่ image เดียวกับ `<version>` ลบทิ้งในหน้า package บน GitHub ได้หลัง push เสร็จ

Image ไม่รัน type check ของ `next build` (Dockerfile ตั้ง `NEXT_SKIP_TYPECHECK=1`) เพราะใช้ memory มากเกินไปใน VM นี้ ให้ปล่อย image จาก commit ที่ผ่าน CI (`tsc --noEmit`) แล้วเท่านั้น


## AWS
```bash
docker compose --env-file .env.local -f vista.db.yml up -d
```

```bash
docker compose --env-file .env.local -f vista.app.yml up -d
or
docker compose --env-file .env.local -f vista.app.yml up -d --build
```

```bash
docker compose -f vista.app.yml logs -f vista
```

```bash
docker compose -f vista.app.yml ps
docker compose -f vista.app.yml down
```