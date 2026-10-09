# Vista Image

คำสั่ง build และ push image ของ `vista-app` กำหนดไว้ใน `vista.package.json` โดยใช้ค่า `version` เป็น tag ของ image บน GitHub Container Registry (GHCR)

## เปลี่ยนเวอร์ชัน

แก้ค่า `version` ใน `vista.package.json` เป็นเวอร์ชันใหม่ก่อน build หรือ push เช่น:

```json
{
  "version": "1.0.1"
}
```

เลือก tag ใหม่ทุกครั้งที่ต้องการปล่อย image เวอร์ชันใหม่ เพื่อไม่ให้ image เก่าถูกเขียนทับ

## Build image

สั่ง build image สำหรับ architecture ปัจจุบัน:

```bash
pnpm run vista:build
```

คำสั่งจะ tag image เป็น `ghcr.io/techflowasia/vista-app:<version>` ตาม `version` ใน `vista.package.json` และโหลดเข้า local Docker image store

## Push multi-platform image

ต้องติดตั้งและเปิดใช้ Docker Buildx พร้อม builder ที่รองรับ multi-platform build และ login เข้า GHCR ก่อน:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-username> --password-stdin
```

ใช้ GitHub token ที่มีสิทธิ์เขียน package (`write:packages`) แล้ว push สำหรับ `linux/amd64` และ `linux/arm64`:

```bash
pnpm run vista:push
```

Image จะถูก push เป็น `ghcr.io/techflowasia/vista-app:<version>` โดย `<version>` มาจาก `vista.package.json` เช่น `1.0.1`
