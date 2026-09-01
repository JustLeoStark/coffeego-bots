// Bitrix24 lead creation via inbound webhook.
// Set BITRIX_WEBHOOK_URL to your inbound webhook base, e.g.
//   https://YOURACCOUNT.bitrix24.com/rest/1/XXXXXXXXXXXXXXXX/
// The bot calls crm.lead.add on it. If the var is unset, leads are logged only.

const WEBHOOK = process.env.BITRIX_WEBHOOK_URL || "";

export async function createLead(lead) {
  const fields = {
    TITLE: lead.title || "CoffeeGo bot lead",
    NAME: lead.name || "",
    SOURCE_ID: "WEB",
    SOURCE_DESCRIPTION: "CoffeeGo chat bot",
    COMMENTS: lead.comments || "",
    OPENED: "Y",
    ASSIGNED_BY_ID: process.env.BITRIX_ASSIGNED_TO || undefined,
  };
  if (lead.phone) fields.PHONE = [{ VALUE: lead.phone, VALUE_TYPE: "WORK" }];
  if (lead.email) fields.EMAIL = [{ VALUE: lead.email, VALUE_TYPE: "WORK" }];

  if (!WEBHOOK) {
    console.log("[bitrix] BITRIX_WEBHOOK_URL not set — lead not sent. Payload:", JSON.stringify(fields));
    return { ok: false, skipped: true };
  }

  const url = WEBHOOK.replace(/\/?$/, "/") + "crm.lead.add.json";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields, params: { REGISTER_SONET_EVENT: "Y" } }),
    });
    const json = await res.json();
    if (json.error) {
      console.error("[bitrix] error:", json.error, json.error_description);
      return { ok: false, error: json.error_description };
    }
    console.log("[bitrix] lead created, id=", json.result);
    return { ok: true, id: json.result };
  } catch (e) {
    console.error("[bitrix] request failed:", e.message);
    return { ok: false, error: e.message };
  }
}
