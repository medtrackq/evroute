# เครื่องคำนวณเส้นทางของ EVROUTE (Valhalla)

เดิมแอปคำนวณเส้นทางที่เซิร์ฟเวอร์อาสาสมัครของ FOSSGIS ซึ่งรับได้ **1 ครั้งต่อวินาที** เครื่องนี้เป็นของเราเอง ใช้ image ทางการของ Valhalla ข้อมูลถนนจาก OpenStreetMap เฉพาะประเทศไทย และเปิดให้แอปเราใช้ทางเครือข่ายภายในของ Railway เท่านั้น

- server ของแอปถามเครื่องนี้ก่อน (`VALHALLA_URL`) ถ้าไม่ตอบหรือไม่ได้ตั้งค่า จะใช้ FOSSGIS แทนอัตโนมัติ แอปจึงไม่พังระหว่างติดตั้ง
- ดูสถานะได้ที่หลังบ้าน → สถานะระบบ → "คำนวณเส้นทาง (Valhalla)" หรือ `https://evroute.info/api/config` → `routing` (`own` = เครื่องเรา · `own-down` = เครื่องเราไม่ตอบ ใช้ FOSSGIS อยู่ · `fossgis` = ยังไม่ได้ตั้ง)
- ค่าใช้จ่ายประมาณ: หน่วยความจำ $10/GB/เดือน · CPU $20/vCPU/เดือน · พื้นที่ $0.15/GB/เดือน (ราคา Railway) เครื่องนี้น่าจะราว $5–10/เดือน ดูของจริงในหน้า Usage หลังใช้ 2–3 วัน

## ติดตั้งบน Railway (ทำครั้งเดียว)

1. **ปรับเพดานค่าใช้จ่าย:** Workspace → Usage → Usage Limits → Hard limit เป็น **$20**
2. **เพิ่ม service:** เปิดโปรเจกต์ที่มี service `evroute` → **+ Create** → **GitHub Repo** → เลือก `medtrackq/evroute`
3. **ตั้งค่า service ใหม่ (Settings):**
   - **Service Name:** `valhalla` (ชื่อนี้กลายเป็นที่อยู่ภายใน `valhalla.railway.internal`)
   - **Source → Branch:** `claude/ev-charging-route-planner-22ihr3`
   - **Source → Root Directory:** `routing`
   - **Source → Watch Paths:** `/routing/**` (**ต้องตั้ง** ไม่งั้นทุกครั้งที่ push งานแอป เครื่องนี้จะเริ่มใหม่และการสร้างแผนที่ที่ค้างอยู่ถูกตัด)
   - **Networking:** **ไม่ต้องกด Generate Domain** (ไม่เปิดให้คนนอกใช้)
4. **เพิ่มที่เก็บข้อมูล:** คลิกขวาที่ service `valhalla` → **Attach Volume** → Mount path `/custom_files`
5. **Deploy** แล้วรอ ครั้งแรกจะโหลดแผนที่ไทยและสร้างข้อมูลเส้นทาง **ราว 1–1.5 ชั่วโมง** ดูใน Deployments → View Logs จนเห็นว่าเริ่มให้บริการแล้ว **ระหว่างนี้อย่ากด Deploy ซ้ำ** (ถ้าโดนตัดกลางทาง ครั้งต่อไปเครื่องจะล้าง volume แล้วโหลดแผนที่และสร้างใหม่เองตั้งแต่ต้น ดู `start.sh`) · สร้างบนดิสก์ของเครื่อง แล้วเก็บลง volume แค่ไฟล์ผลลัพธ์ `valhalla_tiles.tar` กับ `valhalla.json` ครั้งต่อไปที่เครื่องเริ่มใหม่จึงพร้อมใช้ภายในไม่กี่วินาที
6. **บอกแอปให้ใช้เครื่องนี้:** service `evroute` → **Variables** → เพิ่ม `VALHALLA_URL` = `http://valhalla.railway.internal:8002` (ถ้าชื่อในหน้า Settings → Networking → Private Networking ต่างจากนี้ ใช้ตามที่หน้านั้นแสดง)
7. **ตรวจ:** หลังบ้าน → สถานะระบบ → "คำนวณเส้นทาง (Valhalla)" ต้องขึ้น **✓ เครื่องของเราเอง**

## อัปเดตแผนที่ (เดือนละครั้ง หรือเมื่อมีถนนใหม่)

service `valhalla` → Variables → เพิ่ม `force_rebuild` = `True` → เครื่องจะล้าง volume โหลดแผนที่ไทยฉบับล่าสุด แล้วสร้างใหม่ → รอจน log ขึ้น `EVROUTE: build finished` → ลบตัวแปรนั้นออก (ถ้าลืมลบ ทุกครั้งที่เครื่องเริ่มใหม่จะสร้างใหม่หมด) ระหว่างสร้างใหม่ แอปใช้ FOSSGIS แทนอัตโนมัติ

## ถ้าที่เก็บข้อมูลเต็ม (High Volume Usage 99%)

Volume ของแพ็กเกจ Hobby ได้สูงสุด 5 GB ไม่พอสำหรับไฟล์ชั่วคราวระหว่างสร้าง (เคยเต็มกลางทาง 24 พ.ย.) `start.sh` จึงสร้างบนดิสก์ของเครื่อง (Hobby ได้ถึง 100 GB หายไปเมื่อเครื่องหยุด) แล้วเก็บลง volume แค่ไฟล์ผลลัพธ์ และล้าง volume ให้เองทุกครั้งที่การสร้างครั้งก่อนไม่เสร็จ ถ้ายังเต็มอยู่ดี วิธีแก้: คลิก `valhalla-volume` → **Settings** → **Wipe Volume** (ล้างให้ว่าง) แล้วรอ service `valhalla` เริ่มสร้างใหม่ (หรือกด Redeploy ที่ service ครั้งเดียว) ระหว่างสร้างอย่ากด Deploy ซ้ำ

## อ่าน log อย่างไร (Deployments → deployment บนสุด → Deploy Logs)

- `EVROUTE: volume … used of …` พื้นที่ตอนเริ่ม
- `EVROUTE: no finished build on the volume …` การสร้างครั้งก่อนไม่เสร็จ ล้างแล้วเริ่มใหม่ (ปกติในครั้งแรก)
- `EVROUTE: map complete (… md5 matches)` โหลดแผนที่ครบแล้ว
- `EVROUTE: building country borders …` แล้วมีตัวแดง RTTOPO / Self-intersection เยอะ ๆ เป็นเรื่องปกติ
- `EVROUTE: building routing tiles` ส่วนที่นานที่สุด · `EVROUTE: packing tiles onto the volume` ใกล้เสร็จ
- `EVROUTE: build finished (… of tiles on the volume)` แล้ว `EVROUTE: serving on port 8002` เสร็จ ใช้งานได้ (`/api/config` ขึ้น `own` ภายในไม่กี่นาที)
- `No space left on device` volume เต็ม · `Killed` หรือ exit code 137 หน่วยความจำไม่พอ
