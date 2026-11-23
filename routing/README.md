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
   - **Source → Watch Paths:** `routing/**` (แก้แอปแล้วเครื่องนี้ไม่ต้องสร้างใหม่)
   - **Networking:** **ไม่ต้องกด Generate Domain** (ไม่เปิดให้คนนอกใช้)
4. **เพิ่มที่เก็บข้อมูล:** คลิกขวาที่ service `valhalla` → **Attach Volume** → Mount path `/custom_files`
5. **Deploy** แล้วรอ ครั้งแรกจะโหลดแผนที่ไทยและสร้างข้อมูลเส้นทาง **ราว 20–60 นาที** ดูใน Deployments → View Logs จนเห็นว่าเริ่มให้บริการแล้ว **ระหว่างนี้อย่ากด Deploy ซ้ำ** (ถ้าโดนตัดกลางทาง ครั้งต่อไปเครื่องจะสร้างใหม่เองตั้งแต่ต้น)
6. **บอกแอปให้ใช้เครื่องนี้:** service `evroute` → **Variables** → เพิ่ม `VALHALLA_URL` = `http://valhalla.railway.internal:8002` (ถ้าชื่อในหน้า Settings → Networking → Private Networking ต่างจากนี้ ใช้ตามที่หน้านั้นแสดง)
7. **ตรวจ:** หลังบ้าน → สถานะระบบ → "คำนวณเส้นทาง (Valhalla)" ต้องขึ้น **✓ เครื่องของเราเอง**

## อัปเดตแผนที่ (เดือนละครั้ง หรือเมื่อมีถนนใหม่)

service `valhalla` → Variables → เพิ่ม `force_rebuild` = `True` → รอ deploy สร้างใหม่เสร็จ → ลบตัวแปรนั้นออก (ระหว่างสร้างใหม่ แอปใช้ FOSSGIS แทนอัตโนมัติ)
