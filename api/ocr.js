/* ============================================================================
   /api/ocr  —  อ่านใบ "รายงานแสดงสรุปการทำงานประจำวัน" จากรูปถ่าย
   ----------------------------------------------------------------------------
   ทำงานบน Vercel เป็น Serverless Function
   API key เก็บเป็น Environment Variable ชื่อ ANTHROPIC_API_KEY
   ห้ามเอา key ไปใส่ใน index.html เด็ดขาด เพราะใครเปิดดูโค้ดก็เห็น
   ============================================================================ */

const MODEL = "claude-sonnet-5";
const MAX_BYTES = 6 * 1024 * 1024;

const PROMPT = `คุณกำลังอ่าน "รายงานแสดงสรุปการทำงานประจำวัน" ของโรงงานในไทย จากรูปถ่าย

โครงสร้างเอกสาร
- หัวกระดาษมี รหัสพนักงาน, ชื่อ-นามสกุล, ตำแหน่ง, ค่าเบี้ยขยัน, ช่วงวันที่ (เช่น 16/07/2026 ถึง 15/08/2026)
- ตารางกลางมีบรรทัดละ 1 วัน
- กลุ่มคอลัมน์ "สรุปชั่วโมงโอที(ชม:นาที)" มี 6 ช่องเรียงจากซ้ายไปขวาคือ
  1 | 1.5 | 3 | 1.5 Public | 2 Public | Other
- ถัดไปทางขวาคือ ค่าอาหาร, ค่าอาหารล่วงเวลา, ค่ากะ
- แถวล่างสุดของตารางคือ "แถวรวม" มีผลรวมของแต่ละคอลัมน์

สิ่งที่ต้องทำ
อ่านเฉพาะ "แถวรวมล่างสุด" เป็นหลัก อย่าบวกเลขรายวันเอง
- ชั่วโมงโอทีอ่านเป็นข้อความรูปแบบ ชม:นาที เช่น "49:30" ช่องที่ว่างให้เป็น ""
- ค่าอาหาร / ค่าอาหารล่วงเวลา / ค่ากะ ในแถวรวมเป็น "จำนวนเงินรวม" ไม่ใช่จำนวนวัน
  ให้แปลงกลับเป็นจำนวนวันโดยหารด้วยเรตต่อวันที่เห็นในคอลัมน์นั้น
  (ปกติ ค่าอาหาร 50 ต่อวัน, ค่าอาหารล่วงเวลา 35 ต่อวัน, ค่ากะ 120 ต่อกะ)
  ถ้าเรตในเอกสารไม่ใช่ค่านี้ ให้ใช้เรตที่เห็นจริงในเอกสาร
- ถ้าตัวเลขช่องไหนอ่านไม่ชัด ให้ใส่ชื่อช่องนั้นใน uncertain

ตรวจคุณภาพรูปก่อน
ถ้ารูปเบลอจนอ่านตัวเลขไม่ออก, มืดเกินไป, ถ่ายเอียงจนตารางขาด, ถ่ายไม่ติดแถวรวม,
หรือไม่ใช่เอกสารชนิดนี้ ให้ตอบ readable=false พร้อมบอกเหตุผลสั้น ๆ เป็นภาษาไทย
ในช่อง problem และบอกวิธีถ่ายใหม่ใน advice

ตอบกลับเป็น JSON อย่างเดียว ห้ามมีข้อความอื่นหรือ markdown ห้ามใส่ \`\`\`
รูปแบบ:
{
  "readable": true,
  "problem": "",
  "advice": "",
  "confidence": 95,
  "period": "16/07/2026 - 15/08/2026",
  "employeeCode": "150770",
  "employeeName": "",
  "diligence": 1200,
  "ot": { "h1": "24:00", "h15": "49:30", "h3": "16:30", "h15p": "24:00", "h2p": "", "other": "" },
  "dayCounts": { "meal": 24, "otMeal": 24, "shift": 14 },
  "rawTotals": { "meal": 1200, "otMeal": 840, "shift": 1680 },
  "uncertain": []
}`;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "ใช้ POST เท่านั้น" });
    return;
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    res.status(500).json({
      ok: false,
      error: "ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY",
      hint: "ไปที่ Vercel → Settings → Environment Variables → เพิ่ม ANTHROPIC_API_KEY แล้ว Redeploy",
    });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const dataUrl = body.image || "";
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl);
    if (!m) {
      res.status(400).json({ ok: false, error: "ไม่พบรูปภาพที่ส่งมา" });
      return;
    }
    const mediaType = m[1];
    const b64 = m[2];
    if (b64.length * 0.75 > MAX_BYTES) {
      res.status(413).json({ ok: false, error: "รูปใหญ่เกินไป ลองถ่ายใหม่" });
      return;
    }

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
              { type: "text", text: PROMPT },
            ],
          },
        ],
      }),
    });

    if (!r.ok) {
      const detail = await r.text();
      res.status(502).json({
        ok: false,
        error: "เรียก Claude API ไม่สำเร็จ (" + r.status + ")",
        detail: detail.slice(0, 400),
      });
      return;
    }

    const out = await r.json();
    const text = (out.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();

    let data;
    try {
      data = JSON.parse(text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim());
    } catch (e) {
      res.status(502).json({ ok: false, error: "อ่านผลลัพธ์ไม่ได้", detail: text.slice(0, 400) });
      return;
    }

    res.status(200).json({ ok: true, data, usage: out.usage || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: "เกิดข้อผิดพลาดฝั่งเซิร์ฟเวอร์", detail: String(err).slice(0, 300) });
  }
};
