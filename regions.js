// Регионы и франшизы: кто отвечает клиенту и в какие часы.
//
// Единый номер WhatsApp на всю сеть — сознательное решение владельца:
// франчайзи не получает доступа к API, а работает через бота как обычный
// сотрудник. Значит он не может ни разослать спам с номера бренда, ни
// увести клиентскую базу, а вся переписка остаётся у нас.
//
// Регион определяется по коду страны клиента. Настройки регионов лежат в
// хранилище (store.js) и правятся командами бота — код трогать не нужно.

// Код страны → регион. Порядок важен: сначала длинные префиксы.
const PREFIXES = [
  ["971", "uae"],
  ["966", "ksa"],
  ["974", "qatar"],
  ["973", "bahrain"],
  ["965", "kuwait"],
  ["968", "oman"],
  ["7", "ru"],          // Россия и Казахстан идут одним кодом
  ["380", "ua"],
  ["995", "ge"],
  ["998", "uz"],
];

export const DEFAULT_REGION = "uae";

export const REGION_NAMES = {
  uae: "ОАЭ",
  ksa: "Саудовская Аравия",
  qatar: "Катар",
  bahrain: "Бахрейн",
  kuwait: "Кувейт",
  oman: "Оман",
  ru: "Россия и Казахстан",
  ua: "Украина",
  ge: "Грузия",
  uz: "Узбекистан",
  other: "прочие страны",
};

// Часы работы поддержки: [начало, конец) по местному времени региона и
// сдвиг от UTC. Вне этих часов бот отвечает сам и обещает срок.
export const REGION_HOURS = {
  uae: { from: 9, to: 18, utc: 4, days: [0, 1, 2, 3, 4, 6] },  // вс–чт, сб
  ksa: { from: 9, to: 18, utc: 3, days: [0, 1, 2, 3, 4, 6] },
  qatar: { from: 9, to: 18, utc: 3, days: [0, 1, 2, 3, 4, 6] },
  bahrain: { from: 9, to: 18, utc: 3, days: [0, 1, 2, 3, 4, 6] },
  kuwait: { from: 9, to: 18, utc: 3, days: [0, 1, 2, 3, 4, 6] },
  oman: { from: 9, to: 18, utc: 4, days: [0, 1, 2, 3, 4, 6] },
  ru: { from: 9, to: 18, utc: 3, days: [1, 2, 3, 4, 5] },      // пн–пт
  ua: { from: 9, to: 18, utc: 3, days: [1, 2, 3, 4, 5] },
  ge: { from: 9, to: 18, utc: 4, days: [1, 2, 3, 4, 5] },
  uz: { from: 9, to: 18, utc: 5, days: [1, 2, 3, 4, 5] },
  other: { from: 9, to: 18, utc: 4, days: [1, 2, 3, 4, 5] },
};

/** Регион клиента по его номеру телефона (формат WhatsApp: 971501234567). */
export function regionOf(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return DEFAULT_REGION;
  for (const [prefix, region] of
       [...PREFIXES].sort((a, b) => b[0].length - a[0].length)) {
    if (digits.startsWith(prefix)) return region;
  }
  return "other";
}

/** Рабочее ли сейчас время в регионе. */
export function isWorkingHours(region, now = new Date()) {
  const cfg = REGION_HOURS[region] || REGION_HOURS.other;
  const local = new Date(now.getTime() + cfg.utc * 3600 * 1000);
  const day = local.getUTCDay();
  const hour = local.getUTCHours();
  if (!cfg.days.includes(day)) return false;
  return hour >= cfg.from && hour < cfg.to;
}

/** Через сколько часов регион откроется — для честного обещания клиенту. */
export function hoursUntilOpen(region, now = new Date()) {
  const cfg = REGION_HOURS[region] || REGION_HOURS.other;
  for (let h = 1; h <= 24 * 4; h++) {
    const t = new Date(now.getTime() + h * 3600 * 1000);
    if (isWorkingHours(region, t)) return h;
  }
  return null;
}

/** Текст «ответим тогда-то» — на языке региона. */
export function outOfHoursNote(region, lang = "en") {
  const h = hoursUntilOpen(region);
  if (h === null) return "";
  const ru = lang === "ru";
  if (h <= 1) {
    return ru ? "Наш сотрудник ответит в течение часа."
              : "Our team will reply within the hour.";
  }
  if (h <= 14) {
    return ru ? `Сейчас нерабочее время. Ответим в течение ${h} ч.`
              : `We're outside working hours. We'll reply within ${h} h.`;
  }
  return ru ? "Сейчас нерабочее время. Ответим в начале следующего рабочего дня."
            : "We're outside working hours. We'll reply at the start of the next business day.";
}

/** Ключ роли с учётом региона: сначала ищем точную, потом общую. */
export function roleKeys(role, region) {
  const r = region || DEFAULT_REGION;
  return [`${role}@${r}`, role, `default@${r}`, "default"];
}
