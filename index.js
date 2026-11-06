const { Telegraf, Markup } = require("telegraf");
const admin = require("firebase-admin");
require("dotenv").config();

// ─────────────────────────────────────────────
// SOZLAMALAR
// ─────────────────────────────────────────────

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = 8750197296;
const ADMIN_CHAT_ID = "@seoulflix_baza";

// VIP sozlamalari
const VIP_PRICE = 29000;                        // so'm
const VIP_DAYS = 30;                            // bitta to'lov necha kunga
const VIP_AHEAD = 3;                            // VIP oddiy foydalanuvchidan nechta qism oldinda
const VIP_CARD_NUMBER = "9860 1666 5498 9424";  // ← O'Z KARTA RAQAMINGIZNI YOZING
const VIP_CARD_OWNER = "Azizbek Sharifjonov";          // ← KARTA EGASINING ISMI
const VIP_SKIPS_SUBSCRIPTION = false;           // true bo'lsa, VIP'lardan majburiy kanallar so'ralmaydi
const PAYMENT_WAIT_HOURS = 24;                  // kutilayotgan to'lov shu vaqtdan keyin "eskirgan" hisoblanadi
const REMINDER_DAYS = 3;                        // VIP tugashiga necha kun qolganda eslatiladi
const DAY_MS = 24 * 60 * 60 * 1000;

const serviceAccount = JSON.parse(
    Buffer.from(process.env.GOOGLE_APPLICATION_CREDENTIALS, "base64").toString("utf-8")
);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// Xotiradagi holatlar (bot qayta ishga tushsa tozalanadi)
const userStates = {};
const advData = {};
const filmDrafts = {};
const episodeTemplates = {};
const vipAdminTarget = {};
const editTarget = {}; // admin: tahrirlanayotgan qism { code, field }

// Yangi qism xabarnomalari
const NOTIFY_ENABLED = true;   // false bo'lsa, yangi qism haqida avtomatik xabar yuborilmaydi
const NOTIFY_DELAY_MIN = 3;    // oxirgi qism qo'shilgandan necha daqiqa keyin yuboriladi (ketma-ket qismlar bitta xabarga yig'iladi)

// Klaviatura tugmalari (bir joyda, xato qilmaslik uchun)
const BTN = {
    LIST: "📜 Kino roʻyxati",
    SEARCH: "🔍 Kino izlash",
    VIP: "💎 VIP",
    ADV: "📢 Reklama yuborish",
    COUNT: "📈 Statistika",
    CHANNELS: "📡 Majburiy kanallar",
    ADD_DRAMA: "🎬 Drama qo'shish",
    ADD_EP: "➕ Qism qo'shish",
    DOWNLOAD: "⭐ Yuklab olish ruxsati",
    VIP_ADMIN: "💎 VIP boshqaruvi",
    EDIT_EP: "✏️ Qismni tahrirlash",
};
// Eski klaviaturada qolgan tugma nomlari (admin /start bosmaguncha ishlashi uchun)
const LEGACY_COUNT_BTN = "👥 Obunachilar soni";
const MENU_BUTTONS = [...Object.values(BTN), LEGACY_COUNT_BTN];

const FILM_OPTIONAL_STEPS = [
    { key: "episode", label: "🎞️ Nechanchi qism ekanini yuboring (masalan: 1 yoki 1-qism):" },
    { key: "year", label: "🗓️ Chiqarilgan yilini yuboring (masalan: 2024):" },
    { key: "translator", label: "🎧 Tarjimon nomini yuboring:" },
    { key: "language", label: "🌐 Tilini yuboring (masalan: O'zbekcha):" },
    { key: "genre", label: "📄 Janrini yuboring (masalan: Drama, Romantika):" },
    { key: "description", label: "📕 Tavsifini yuboring:" },
];

let CHECK_CHANNELS = [];
let SHOW_CHANNELS = [];
let DOWNLOAD_USERNAMES = new Set(); // videoni himoyasiz oladiganlar (eski "vipUsers" kolleksiyasi)

// ─────────────────────────────────────────────
// UMUMIY YORDAMCHI FUNKSIYALAR
// ─────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function esc(value) {
    return String(value === undefined || value === null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function formatSum(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

// Toshkent vaqti (UTC+5) bo'yicha dd.mm.yyyy
function fmtDate(ms) {
    const d = new Date(ms + 5 * 60 * 60 * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

function parseEpNo(label) {
    const m = String(label || "").match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
}

// "5" -> "5-qism", qolganini o'zgartirmaydi
function normalizeEpisode(text) {
    const t = String(text).trim();
    return /^\d+$/.test(t) ? `${parseInt(t, 10)}-qism` : t;
}

// Firestore hujjat ID'si sifatida xavfsizmi
function isValidCode(code) {
    return (
        typeof code === "string" &&
        code.length > 0 &&
        code.length <= 100 &&
        !code.includes("/") &&
        code !== "." &&
        code !== ".." &&
        !/^__.*__$/.test(code)
    );
}

function displayName(u) {
    const full = [u.firstName, u.lastName].filter(Boolean).join(" ");
    return full || u.username || String(u.userId);
}

// Har qanday ko'rinishdagi sanani millisekundga aylantiradi
// (Firestore Timestamp, Date, son, "dd.mm.yyyy" yoki ISO matn — qo'lda kiritilgan VIP'lar ham hisoblanadi)
function tsToMs(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (ts instanceof Date) return ts.getTime();
    if (typeof ts === "number") return ts < 1e12 ? ts * 1000 : ts; // soniya yoki millisekund
    if (typeof ts === "object") {
        if (typeof ts._seconds === "number") return ts._seconds * 1000;
        if (typeof ts.seconds === "number") return ts.seconds * 1000;
    }
    if (typeof ts === "string") {
        const s = ts.trim();
        if (/^\d+$/.test(s)) return tsToMs(Number(s));
        const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
        if (m) {
            // kun oxirigacha (Toshkent vaqti)
            return Date.UTC(+m[3], +m[2] - 1, +m[1], 23, 59, 59) - 5 * 60 * 60 * 1000;
        }
        const parsed = Date.parse(s);
        return isNaN(parsed) ? 0 : parsed;
    }
    return 0;
}

// "29 000", "29000 so'm", 29000 -> 29000
function parseAmount(v) {
    if (typeof v === "number") return v;
    const n = parseInt(String(v || "").replace(/\D/g, ""), 10);
    return isNaN(n) ? 0 : n;
}

// Kun soniga mos narx (30 kun = VIP_PRICE)
function priceForDays(days) {
    return Math.round((VIP_PRICE * days) / VIP_DAYS);
}

async function sendChunks(ctx, header, lines, extra = { parse_mode: "HTML" }) {
    const chunks = [];
    let current = header;
    for (const line of lines) {
        // Telegram xabar limiti 4096 belgi
        if (current.length + line.length + 1 > 3800) {
            chunks.push(current);
            current = line;
        } else {
            current += (current ? "\n" : "") + line;
        }
    }
    if (current) chunks.push(current);
    for (const chunk of chunks) await ctx.reply(chunk, extra);
}

async function loadDownloadUsers() {
    const snapshot = await db.collection("vipUsers").get();
    DOWNLOAD_USERNAMES = new Set(snapshot.docs.map((doc) => doc.id));
}

async function loadChannels() {
    const snapshot = await db.collection("channels").get();
    CHECK_CHANNELS = snapshot.docs.map((doc) => doc.data().channelId);
    SHOW_CHANNELS = snapshot.docs.map((doc) => ({ name: doc.data().name, url: doc.data().url }));
}

async function seedChannelsIfEmpty() {
    const snapshot = await db.collection("channels").get();
    if (snapshot.empty) {
        const defaults = [
            { id: "asaxi_uz", channelId: "@asaxi_uz", name: "Asaxi tv", url: "https://t.me/asaxi_uz" },
            { id: "seoulflixorg", channelId: "@seoulflixorg", name: "SX", url: "https://t.me/seoulflixorg" },
        ];
        for (const ch of defaults) {
            await db.collection("channels").doc(ch.id).set({
                channelId: ch.channelId,
                name: ch.name,
                url: ch.url,
            });
        }
    }
}

// ─────────────────────────────────────────────
// VIP: HOLAT, BERISH, TO'LOVLAR
// ─────────────────────────────────────────────

async function getVipInfo(userId) {
    const snap = await db.collection("vips").doc(String(userId)).get();
    if (!snap.exists) return null;
    const data = snap.data();
    const expiresMs = tsToMs(data.expiresAt);
    return { ...data, expiresMs, active: expiresMs > Date.now() };
}

// Admin har doim VIP huquqiga ega
async function hasVipAccess(userId) {
    if (userId === ADMIN_ID) return true;
    const info = await getVipInfo(userId);
    return !!(info && info.active);
}

async function getActiveVipIds() {
    const snap = await db.collection("vips").get();
    const now = Date.now();
    const ids = new Set();
    snap.forEach((doc) => {
        if (tsToMs(doc.data().expiresAt) > now) ids.add(doc.id);
    });
    return ids;
}

// Faol VIP bo'lsa muddat ustiga qo'shiladi, bo'lmasa hozirdan boshlanadi
function calcExpiry(vipSnap, days) {
    const now = Date.now();
    let base = now;
    if (vipSnap && vipSnap.exists) {
        const cur = tsToMs(vipSnap.data().expiresAt);
        if (cur > now) base = cur;
    }
    return base + days * DAY_MS;
}

function vipDocData(target, expiresMs, grantedBy, isNew) {
    const data = {
        userId: Number(target.userId),
        username: target.username || "",
        firstName: target.firstName || "",
        lastName: target.lastName || "",
        expiresAt: admin.firestore.Timestamp.fromMillis(expiresMs),
        updatedAt: admin.firestore.Timestamp.now(),
        lastGrantedBy: grantedBy,
        remindedSoon: false,
        remindedExpired: false,
    };
    if (isNew) data.startedAt = admin.firestore.Timestamp.now();
    return data;
}

// Admin qo'lda bergan VIP ham to'lov sifatida yoziladi.
// amount = 0 bo'lsa "tekin" hisoblanadi va tushumga qo'shilmaydi.
async function grantVipDays(target, days, grantedBy, amount = priceForDays(days)) {
    const ref = db.collection("vips").doc(String(target.userId));
    const payRef = db.collection("payments").doc();
    return db.runTransaction(async (t) => {
        const snap = await t.get(ref);
        const expiresMs = calcExpiry(snap, days);
        t.set(ref, vipDocData(target, expiresMs, grantedBy, !snap.exists), { merge: true });
        t.set(payRef, {
            userId: Number(target.userId),
            username: target.username || "",
            firstName: target.firstName || "",
            lastName: target.lastName || "",
            amount,
            free: amount === 0,
            days,
            status: "approved",
            source: "admin",
            createdAt: admin.firestore.Timestamp.now(),
            decidedAt: admin.firestore.Timestamp.now(),
        });
        return expiresMs;
    });
}

// Bir martalik: avval admin qo'lda bergan (to'lov yozuvi yo'q) VIP'lar uchun to'lov yozuvini tiklaydi
async function backfillManualVipPayments() {
    const [vipSnap, paySnap] = await Promise.all([
        db.collection("vips").get(),
        db.collection("payments").get(),
    ]);
    const paidUsers = new Set();
    paySnap.forEach((d) => {
        const p = d.data();
        if (p.status === "approved" && p.userId !== undefined) paidUsers.add(String(p.userId));
    });

    let added = 0;
    for (const doc of vipSnap.docs) {
        const v = doc.data();
        if (v.revenueBackfilled || paidUsers.has(doc.id)) continue;
        const exp = tsToMs(v.expiresAt);
        const start = tsToMs(v.startedAt) || (doc.createTime ? doc.createTime.toMillis() : 0);
        if (!exp || !start || exp <= start) continue;

        const days = Math.max(1, Math.round((exp - start) / DAY_MS));
        const batch = db.batch();
        batch.set(db.collection("payments").doc(), {
            userId: Number(v.userId || doc.id),
            username: v.username || "",
            firstName: v.firstName || "",
            lastName: v.lastName || "",
            amount: priceForDays(days),
            days,
            status: "approved",
            source: "admin",
            backfilled: true,
            createdAt: admin.firestore.Timestamp.fromMillis(start),
            decidedAt: admin.firestore.Timestamp.now(),
        });
        batch.update(doc.ref, { revenueBackfilled: true });
        await batch.commit();
        added++;
    }
    if (added) console.log(`💎 ${added} ta qo'lda berilgan VIP uchun to'lov yozuvi tiklandi.`);
}

// To'lovni tasdiqlash: bir marta ishlashi kafolatlangan (qayta bosilsa ikki marta VIP bermaydi)
async function approvePayment(paymentId) {
    const payRef = db.collection("payments").doc(paymentId);
    return db.runTransaction(async (t) => {
        const paySnap = await t.get(payRef);
        if (!paySnap.exists) return { status: "missing" };
        const p = paySnap.data();
        if (p.status !== "pending") return { status: "already" };

        const vipRef = db.collection("vips").doc(String(p.userId));
        const vipSnap = await t.get(vipRef);
        const expiresMs = calcExpiry(vipSnap, p.days || VIP_DAYS);

        t.set(
            vipRef,
            vipDocData(
                { userId: p.userId, username: p.username, firstName: p.firstName, lastName: p.lastName },
                expiresMs,
                "payment",
                !vipSnap.exists
            ),
            { merge: true }
        );
        t.update(payRef, { status: "approved", decidedAt: admin.firestore.Timestamp.now() });
        return { status: "approved", userId: p.userId, expiresMs };
    });
}

async function rejectPayment(paymentId) {
    const payRef = db.collection("payments").doc(paymentId);
    return db.runTransaction(async (t) => {
        const paySnap = await t.get(payRef);
        if (!paySnap.exists) return { status: "missing" };
        const p = paySnap.data();
        if (p.status !== "pending") return { status: "already" };
        t.update(payRef, { status: "rejected", decidedAt: admin.firestore.Timestamp.now() });
        return { status: "rejected", userId: p.userId };
    });
}

async function findPendingPayment(userId) {
    const snap = await db.collection("payments").where("userId", "==", userId).get();
    const limit = Date.now() - PAYMENT_WAIT_HOURS * 60 * 60 * 1000;
    return (
        snap.docs.find((d) => {
            const p = d.data();
            return p.status === "pending" && tsToMs(p.createdAt) > limit;
        }) || null
    );
}

// @username yoki ID bo'yicha foydalanuvchini topish (faqat botdan foydalanganlar)
async function resolveUser(input) {
    const t = String(input).trim();
    if (/^\d+$/.test(t)) {
        const id = Number(t);
        const d = await db.collection("users").doc(t).get();
        if (d.exists) return { ...d.data(), userId: id };
        const v = await db.collection("vips").doc(t).get();
        if (v.exists) return { ...v.data(), userId: id };
        // Bazada yo'q bo'lsa ham ID bo'yicha ishlaymiz
        try {
            const chat = await bot.telegram.getChat(id);
            return {
                userId: id,
                username: chat.username || "",
                firstName: chat.first_name || "",
                lastName: chat.last_name || "",
            };
        } catch (err) {
            return { userId: id, username: "", firstName: "", lastName: "" };
        }
    }
    const uname = t.replace(/^@/, "").toLowerCase();
    if (!uname) return null;
    for (const col of ["users", "vips"]) {
        const snap = await db.collection(col).get();
        const found = snap.docs.find((d) => String(d.data().username || "").toLowerCase() === uname);
        if (found) return { ...found.data(), userId: Number(found.data().userId || found.id) };
    }
    return null;
}

function vipBenefitsText() {
    return (
        `✨ <b>VIP imkoniyatlari:</b>\n` +
        `📺 Reklamasiz tomosha: reklama xabarlari yuborilmaydi\n` +
        `⚡ Yangi qismlarni oddiy foydalanuvchilardan <b>${VIP_AHEAD} qism oldin</b> ko'rasiz`
    );
}

async function sendVipScreen(ctx) {
    const info = await getVipInfo(ctx.from.id);

    if (info && info.active) {
        const left = Math.max(1, Math.ceil((info.expiresMs - Date.now()) / DAY_MS));
        return ctx.reply(
            `💎 <b>Sizda VIP faol</b>\n\n` +
            `📅 Amal qilish muddati: <b>${fmtDate(info.expiresMs)}</b> gacha (${left} kun qoldi)\n\n` +
            `${vipBenefitsText()}\n\n` +
            `Muddatni uzaytirsangiz, qolgan kunlaringiz yo'qolmaydi.`,
            {
                parse_mode: "HTML",
                ...Markup.inlineKeyboard([[Markup.button.callback("🔄 VIP'ni uzaytirish", "vip_buy")]]),
            }
        );
    }

    const expiredLine = info ? `⌛ Oldingi VIP muddatingiz ${fmtDate(info.expiresMs)} da tugagan.\n\n` : "";
    return ctx.reply(
        `💎 <b>SeoulFlix VIP</b>\n\n${expiredLine}${vipBenefitsText()}\n\n` +
        `💰 Narxi: <b>${formatSum(VIP_PRICE)} so'm</b> / ${VIP_DAYS} kun`,
        {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([[Markup.button.callback("💳 VIP sotib olish", "vip_buy")]]),
        }
    );
}

// VIP muddati haqida eslatmalar (tugashiga REMINDER_DAYS kun qolganda va tugaganda)
async function vipReminderJob() {
    const snap = await db.collection("vips").get();
    const now = Date.now();
    for (const doc of snap.docs) {
        const d = doc.data();
        const exp = tsToMs(d.expiresAt);
        const uid = d.userId || Number(doc.id);
        try {
            if (exp > now && exp - now <= REMINDER_DAYS * DAY_MS && !d.remindedSoon) {
                await doc.ref.update({ remindedSoon: true });
                await bot.telegram.sendMessage(
                    uid,
                    `⏰ VIP muddatingiz <b>${fmtDate(exp)}</b> da tugaydi.\n\nUzaytirish uchun «${BTN.VIP}» tugmasini bosing.`,
                    { parse_mode: "HTML" }
                );
            } else if (exp <= now && !d.remindedExpired) {
                await doc.ref.update({ remindedExpired: true });
                await bot.telegram.sendMessage(
                    uid,
                    `⌛ VIP muddatingiz tugadi.\n\nQayta faollashtirish uchun «${BTN.VIP}» tugmasini bosing.`
                );
            }
        } catch (err) {
            if (err.response && err.response.error_code === 403) {
                // foydalanuvchi botni bloklagan: eslatmani qayta urinmaymiz
                await doc.ref.update({ remindedSoon: true, remindedExpired: true }).catch(() => { });
            } else {
                console.error("vipReminderJob xatolik:", err.message);
            }
        }
    }
}

// ─────────────────────────────────────────────
// KINO / QISM YORDAMCHILARI
// ─────────────────────────────────────────────

async function getNextCode() {
    const snap = await db.collection("films").get();
    let max = 0;
    let width = 4;
    snap.forEach((d) => {
        if (/^\d+$/.test(d.id)) {
            max = Math.max(max, parseInt(d.id, 10));
            width = Math.max(width, d.id.length);
        }
    });
    return String(max + 1).padStart(width, "0");
}

async function getMaxEpNo(dramaId, fallback) {
    const snap = await db.collection("films").where("dramaId", "==", dramaId).get();
    let max = fallback || 0;
    snap.forEach((d) => {
        const n = d.data().epNo;
        if (typeof n === "number" && n > max) max = n;
    });
    return max;
}

// VIP uchun yopiq qismlar soni VIP_AHEAD dan oshsa, eng eskilari hammaga ochiladi
async function applyVipWindow(dramaId) {
    const snap = await db.collection("films").where("dramaId", "==", dramaId).get();
    const vipEps = snap.docs
        .filter((d) => d.data().vipOnly === true)
        .sort((a, b) => (a.data().epNo || 0) - (b.data().epNo || 0));
    const excess = vipEps.length - VIP_AHEAD;
    if (excess <= 0) return [];

    const toOpen = vipEps.slice(0, excess);
    const batch = db.batch();
    toOpen.forEach((d) => batch.update(d.ref, { vipOnly: false, openedAt: admin.firestore.Timestamp.now() }));
    await batch.commit();
    return toOpen.map((d) => ({
        code: d.id,
        episode: d.data().episode || "",
        epNo: d.data().epNo,
        title: d.data().title || "",
    }));
}

// Ochilgan qismlar ro'yxatini qaytaradi
async function openAllEpisodes(dramaId) {
    const snap = await db.collection("films").where("dramaId", "==", dramaId).get();
    const closed = snap.docs.filter((d) => d.data().vipOnly === true);
    if (closed.length === 0) return [];
    const batch = db.batch();
    closed.forEach((d) => batch.update(d.ref, { vipOnly: false, openedAt: admin.firestore.Timestamp.now() }));
    await batch.commit();
    return closed.map((d) => ({
        code: d.id,
        episode: d.data().episode || "",
        epNo: d.data().epNo,
        title: d.data().title || "",
    }));
}

function makeTemplate(film, code) {
    return {
        base: {
            title: film.title || "",
            year: film.year || "",
            translator: film.translator || "",
            language: film.language || "",
            genre: film.genre || "",
            description: film.description || "",
        },
        dramaId: film.dramaId || code,
        lastEpNo: typeof film.epNo === "number" ? film.epNo : parseEpNo(film.episode) || 1,
    };
}

function buildCaption(film, views) {
    const parts = [];
    if (film.title) parts.push({ label: "🎬 Nomi:", value: film.title });
    if (film.episode) parts.push({ label: "🎞️ Qism:", value: film.episode });
    if (film.year) parts.push({ label: "🗓️ Yil:", value: film.year });
    if (film.translator) parts.push({ label: "🎧 Tarjima:", value: film.translator });
    if (film.language) parts.push({ label: "🌐 Til:", value: film.language });
    if (film.genre) parts.push({ label: "📄 Janr:", value: film.genre });

    const tailPlain = `👁 Ko'rilgan: ${views} marta`;
    const headPlain = parts.map((p) => `${p.label} ${p.value}`).join("\n");

    // Telegram caption limiti 1024 belgi: uzun tavsifni qisqartiramiz
    const maxDesc = Math.max(0, 1000 - (headPlain.length + tailPlain.length + 40));
    let desc = String(film.description || "");
    if (desc.length > maxDesc) desc = maxDesc > 1 ? desc.slice(0, maxDesc - 1) + "…" : "";

    let caption = parts.map((p) => `${p.label.replace(/^(\S+)\s(.+)$/, "$1 <b>$2</b>")} ${esc(p.value)}\n`).join("");
    if (desc) caption += `\n📕 <b>Tavsifi:</b>\n${esc(desc)}\n`;
    caption += `\n👁 <b>Ko'rilgan:</b> ${views} marta`;
    return caption;
}

async function incrementViewCount(filmId) {
    await db.collection("films").doc(filmId).update({ views: admin.firestore.FieldValue.increment(1) });
}

// ─────────────────────────────────────────────
// ADMIN: DRAMA / QISM QO'SHISH OQIMI
// ─────────────────────────────────────────────

async function askFilmStep(ctx, index) {
    const userId = ctx.from.id;
    if (index >= FILM_OPTIONAL_STEPS.length) {
        return askAudience(ctx);
    }
    const step = FILM_OPTIONAL_STEPS[index];
    userStates[userId] = `waiting_for_film_${step.key}`;
    await ctx.reply(
        step.label,
        Markup.inlineKeyboard([
            [Markup.button.callback("⏭ Otkazib yuborish", "film_skip")],
            [Markup.button.callback("❌ Bekor qilish", "film_cancel")],
        ])
    );
}

// Admin: bu qism VIP uchunmi yoki hammaga
async function askAudience(ctx) {
    const userId = ctx.from.id;
    const draft = filmDrafts[userId] || {};
    userStates[userId] = "waiting_for_film_audience";
    const label = [draft.title, draft.episode].filter(Boolean).join(" · ");
    await ctx.reply(
        `👥 Bu qism kimlar uchun?${label ? `\n\n🎬 ${label}` : ""}`,
        Markup.inlineKeyboard([
            [Markup.button.callback("💎 Faqat VIP uchun", "aud_vip")],
            [Markup.button.callback("🌍 Hamma uchun", "aud_all")],
            [Markup.button.callback("❌ Bekor qilish", "film_cancel")],
        ])
    );
}

async function askVideo(ctx) {
    const userId = ctx.from.id;
    const draft = filmDrafts[userId] || {};
    userStates[userId] = "waiting_for_film_video";
    await ctx.reply(
        `🎥 Endi videoni yuboring (video fayl sifatida):\n\n👥 Kimga: ${draft.vipOnly ? "💎 Faqat VIP" : "🌍 Hamma"}`,
        Markup.inlineKeyboard([[Markup.button.callback("❌ Bekor qilish", "film_cancel")]])
    );
}

async function askNextEpisode(ctx) {
    const userId = ctx.from.id;
    userStates[userId] = "waiting_for_ep_code";
    const nextCode = await getNextCode();
    await ctx.reply(
        "🔑 Yangi qism kodini yuboring:",
        Markup.inlineKeyboard([
            [Markup.button.callback(`🔢 Avtomatik kod: ${nextCode}`, "ep_autocode")],
            [Markup.button.callback("✅ Tugatish", "ep_finish")],
        ])
    );
}

async function acceptEpisodeCode(ctx, code) {
    const userId = ctx.from.id;
    const tpl = episodeTemplates[userId];
    if (!tpl) {
        delete userStates[userId];
        return ctx.reply("❌ Seans tugagan. «➕ Qism qo'shish» tugmasidan qaytadan boshlang.");
    }
    if (!isValidCode(code)) {
        return ctx.reply("❌ Kod noto'g'ri (\"/\" belgisi bo'lmasligi va juda uzun bo'lmasligi kerak). Boshqa kod yuboring:");
    }
    const existing = await db.collection("films").doc(code).get();
    if (existing.exists) {
        return ctx.reply(`⚠️ "${code}" kodi band. Boshqa kod yuboring:`);
    }

    const next = (await getMaxEpNo(tpl.dramaId, tpl.lastEpNo)) + 1;
    filmDrafts[userId] = { ...tpl.base, code, dramaId: tpl.dramaId, suggestedEp: next };
    userStates[userId] = "waiting_for_ep_number";

    await ctx.reply(
        `🎞 Nechanchi qism? Raqamni yuboring (masalan: ${next}) yoki taklif qilingan tugmani bosing 👇`,
        Markup.inlineKeyboard([
            [Markup.button.callback(`✅ ${next}-qism`, "ep_num_suggest")],
            [Markup.button.callback("❌ Bekor qilish", "film_cancel")],
        ])
    );
}

async function acceptEpisodeNumber(ctx, epNo, label) {
    const userId = ctx.from.id;
    const draft = filmDrafts[userId];
    if (!draft) {
        delete userStates[userId];
        return ctx.reply("❌ Ma'lumot topilmadi. Qaytadan boshlang.");
    }
    const snap = await db.collection("films").where("dramaId", "==", draft.dramaId).get();
    const dup = snap.docs.find((d) => d.data().epNo === epNo);
    if (dup) {
        return ctx.reply(`❌ ${epNo}-qism allaqachon mavjud (kod: ${dup.id}). Boshqa raqam yuboring:`);
    }
    draft.episode = label;
    draft.epNo = epNo;
    return askAudience(ctx);
}

// Video kelganda qismni bazaga saqlash
async function finalizeFilm(ctx, fileId) {
    const userId = ctx.from.id;
    const draft = filmDrafts[userId];
    if (!draft || !draft.code) {
        delete userStates[userId];
        return ctx.reply("❌ Ma'lumotlar topilmadi. Iltimos, qaytadan boshlang.");
    }

    const epNo =
        typeof draft.epNo === "number" ? draft.epNo : parseEpNo(draft.episode) || 1;

    const filmData = {
        title: draft.title || "",
        episode: draft.episode || "",
        year: draft.year || "",
        translator: draft.translator || "",
        language: draft.language || "",
        genre: draft.genre || "",
        description: draft.description || "",
        video_link: fileId,
        views: 0,
        dramaId: draft.dramaId || draft.code,
        epNo,
        vipOnly: draft.vipOnly === true,
        createdAt: admin.firestore.Timestamp.now(),
    };

    let opened = [];
    try {
        await db.collection("films").doc(draft.code).set(filmData);
        if (filmData.vipOnly) opened = await applyVipWindow(filmData.dramaId);
    } catch (err) {
        console.error("Qism saqlashda xatolik:", err);
        return ctx.reply("❌ Saqlashda xatolik yuz berdi. Videoni qayta yuboring.");
    }

    invalidateDramaCache();
    delete userStates[userId];
    delete filmDrafts[userId];
    episodeTemplates[userId] = makeTemplate(filmData, draft.code);

    let msg =
        `✅ <b>Qo'shildi!</b>\n\n` +
        `🎬 ${esc(filmData.title)}${filmData.episode ? " · " + esc(filmData.episode) : ""}\n` +
        `🔑 Kod: <code>${esc(draft.code)}</code>\n` +
        `👥 Kimga: ${filmData.vipOnly ? "💎 Faqat VIP" : "🌍 Hamma"}`;
    if (opened.length > 0) {
        const list = opened
            .map((o) => `${esc(o.episode || "qism")} (<code>${esc(o.code)}</code>)`)
            .join(", ");
        msg += `\n\n🔓 Hammaga ochildi: ${list}`;
    }

    // Kanal postlari uchun havolalar
    const uname = botUsername(ctx);
    if (uname && isDeepLinkSafe(draft.code)) {
        msg += `\n\n🔗 Qism havolasi:\n<code>https://t.me/${uname}?start=${esc(draft.code)}</code>`;
        const groups = await loadDramaGroups(true).catch(() => []);
        const group = findGroupByCode(groups, draft.code);
        if (group && isDeepLinkSafe(`dr_${group.key}`)) {
            msg += `\n📜 Barcha qismlar havolasi:\n<code>https://t.me/${uname}?start=dr_${esc(group.key)}</code>`;
        }
    }

    // Foydalanuvchilarga avtomatik xabarnoma (navbatga qo'yiladi)
    const newEp = { code: draft.code, episode: filmData.episode, epNo: filmData.epNo, title: filmData.title };
    enqueueNotify(newEp, filmData.vipOnly ? "vip" : "all");
    opened.forEach((o) => enqueueNotify(o, "opened"));

    const buttons = [[Markup.button.callback("➕ Keyingi qism", "ep_next")]];
    if (filmData.vipOnly) buttons.push([Markup.button.callback("🔓 Dramani to'liq hammaga ochish", "ep_open_all")]);
    if (NOTIFY_ENABLED) {
        msg += `\n\n🔔 Foydalanuvchilarga xabarnoma ${NOTIFY_DELAY_MIN} daqiqadan keyin yuboriladi (shu orada qo'shilgan qismlar bitta xabarga jamlanadi).`;
    }
    if (NOTIFY_ENABLED && cbFits(`ntf_cancel:${draft.code}`)) {
        buttons.push([
            Markup.button.callback("📣 Hozir yuborish", `ntf_now:${draft.code}`),
            Markup.button.callback("🔕 Yubormaslik", `ntf_cancel:${draft.code}`),
        ]);
    }
    buttons.push([Markup.button.callback("✅ Tugatish", "ep_finish")]);

    return ctx.reply(msg, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
}

// ─────────────────────────────────────────────
// OBUNA TEKSHIRISH
// ─────────────────────────────────────────────

// "Tekshirish" tugmasi: kutilayotgan qism kodi bo'lsa, obunadan keyin o'sha qism darhol yuboriladi
function checkButtonData(pendingCode) {
    const data = pendingCode ? `chk:${pendingCode}` : "";
    return data && Buffer.byteLength(data, "utf8") <= 64 ? data : "check_membership";
}

async function checkSubscription(ctx, pendingCode) {
    const userId = ctx.from.id;
    if (VIP_SKIPS_SUBSCRIPTION && (await hasVipAccess(userId))) return true;

    for (const ch of CHECK_CHANNELS) {
        try {
            const member = await bot.telegram.getChatMember(ch, userId);
            if (["left", "kicked"].includes(member.status)) {
                const buttons = SHOW_CHANNELS.map((c) => [Markup.button.url(c.name, c.url)]);
                buttons.push([Markup.button.callback("✅ Tekshirish", checkButtonData(pendingCode))]);
                await ctx.reply(
                    "❌ Botdan foydalanish uchun quyidagi kanallarga obuna bo'ling 👇",
                    Markup.inlineKeyboard(buttons)
                );
                return false;
            }
        } catch (err) {
            console.log("checkSubscription error:", err.message);
            return false;
        }
    }
    return true;
}

// ─────────────────────────────────────────────
// REKLAMA YUBORISH (VIP'lar reklama olmaydi)
// ─────────────────────────────────────────────

async function sendAdvOne(uid, adv) {
    if (adv.type === "text") {
        return bot.telegram.sendMessage(uid, adv.text, { parse_mode: "HTML" });
    }
    const extra = { caption: adv.caption || "", parse_mode: "HTML" };
    if (adv.type === "photo") return bot.telegram.sendPhoto(uid, adv.fileId, extra);
    if (adv.type === "video") return bot.telegram.sendVideo(uid, adv.fileId, extra);
    if (adv.type === "animation") return bot.telegram.sendAnimation(uid, adv.fileId, extra);
    throw new Error("Noma'lum reklama turi");
}

async function sendAdvToAll(ctx, adv) {
    const usersSnapshot = await db.collection("users").get();
    const vipIds = await getActiveVipIds();
    let success = 0, failed = 0, skipped = 0;

    for (const docSnap of usersSnapshot.docs) {
        const user = docSnap.data();
        const uid = user.userId || Number(docSnap.id);

        if (vipIds.has(String(uid))) {
            skipped++;
            continue;
        }

        try {
            try {
                await sendAdvOne(uid, adv);
            } catch (error) {
                if (error.response && error.response.error_code === 429) {
                    const wait = ((error.response.parameters && error.response.parameters.retry_after) || 1) + 1;
                    await sleep(wait * 1000);
                    await sendAdvOne(uid, adv);
                } else {
                    throw error;
                }
            }
            success++;
        } catch (error) {
            if (error.response && error.response.error_code === 403) {
                await db.collection("users").doc(String(uid)).delete().catch(() => { });
                console.log(`${uid} bazadan o'chirildi (bloklagan)`);
            }
            failed++;
        }
        await sleep(40);
    }

    await ctx.reply(
        `✅ Reklama yuborish yakunlandi!\n\n🟢 Muvaffaqiyatli: ${success} ta\n🔴 Xatolik: ${failed} ta\n💎 VIP (reklama yuborilmadi): ${skipped} ta`
    );
}

// ─────────────────────────────────────────────
// MIDDLEWARE: oddiy foydalanuvchi menyu tugmasini bossa, kutish holati bekor bo'ladi
// ─────────────────────────────────────────────

// Statistika uchun: foydalanuvchi faolligini kuniga bir marta yozib qo'yamiz
const lastTouchDay = new Map();
function touchUser(from) {
    if (!from || from.is_bot) return;
    const day = fmtDate(Date.now());
    if (lastTouchDay.get(from.id) === day) return;
    lastTouchDay.set(from.id, day);
    db.collection("users")
        .doc(String(from.id))
        .set(
            {
                userId: from.id,
                firstName: from.first_name || "",
                lastName: from.last_name || "",
                username: from.username || "",
                lastActiveAt: admin.firestore.Timestamp.now(),
            },
            { merge: true }
        )
        .catch((err) => console.error("touchUser:", err.message));
}

bot.use(async (ctx, next) => {
    const text = ctx.message && ctx.message.text;
    if (text && ctx.from && ctx.from.id !== ADMIN_ID && MENU_BUTTONS.includes(text.trim())) {
        delete userStates[ctx.from.id];
    }
    if (ctx.chat && ctx.chat.type === "private") touchUser(ctx.from);
    return next();
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────

bot.start(async (ctx) => {
    const userId = ctx.from.id;
    delete userStates[userId];
    delete filmDrafts[userId];
    delete episodeTemplates[userId];
    delete vipAdminTarget[userId];
    delete editTarget[userId];

    const userRef = db.collection("users").doc(userId.toString());
    const doc = await userRef.get();

    if (!doc.exists || !doc.data().joinedAt) {
        await userRef.set(
            {
                userId,
                firstName: ctx.from.first_name || "",
                lastName: ctx.from.last_name || "",
                username: ctx.from.username || "",
                joinedAt: admin.firestore.Timestamp.now(),
            },
            { merge: true }
        );
    }

    const keyboard = [[BTN.LIST, BTN.SEARCH], [BTN.VIP]];
    if (userId === ADMIN_ID) {
        keyboard.push([BTN.ADV, BTN.COUNT]);
        keyboard.push([BTN.CHANNELS, BTN.ADD_DRAMA]);
        keyboard.push([BTN.DOWNLOAD, BTN.ADD_EP]);
        keyboard.push([BTN.VIP_ADMIN, BTN.EDIT_EP]);
    }

    // Havola orqali kelgan bo'lsa: t.me/bot?start=0012
    const payload = (String((ctx.message && ctx.message.text) || "").split(/\s+/)[1] || "").trim();

    try {
        await ctx.reply(
            "🎬 SeoulFlix botiga xush kelibsiz!\n\nQuyidagi tugmalar orqali istagan dramangizni topishingiz, drama kodini yoki nomini yuborishingiz mumkin 👇",
            Markup.keyboard(keyboard).resize()
        );

        if (payload && isDeepLinkSafe(payload)) {
            const subscribed = await checkSubscription(ctx, payload);
            if (!subscribed) return;
            const opened = await openDeepLink(ctx, payload);
            if (!opened) await ctx.reply("❌ Bu havoladagi qism topilmadi. «📜 Kino roʻyxati» tugmasidan foydalaning.");
            return;
        }

        const buttons = SHOW_CHANNELS.map((ch) => [Markup.button.url(ch.name, ch.url)]);
        buttons.push([Markup.button.callback("✅ Tekshirish", "check_membership")]);
        await ctx.reply(
            "❌ Botdan foydalanish uchun quyidagi kanallarga obuna bo'ling 👇",
            Markup.inlineKeyboard(buttons)
        );
    } catch (err) {
        if (err.response && err.response.error_code === 403) {
            console.log(`${userId} botni bloklagan.`);
            await userRef.delete().catch(() => { });
        } else {
            console.error("START ERROR:", err);
        }
    }
});

async function getMissingChannels(userId) {
    const notSubscribed = [];
    for (const ch of CHECK_CHANNELS) {
        try {
            const res = await bot.telegram.getChatMember(ch, userId);
            if (["left", "kicked"].includes(res.status)) notSubscribed.push(ch);
        } catch {
            notSubscribed.push(ch);
        }
    }
    return notSubscribed;
}

// Havola/qism tugmasidan kelgan foydalanuvchi obuna bo'lgach, qism darhol yuboriladi
bot.action(/^chk:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const code = ctx.match[1];
    const missing = await getMissingChannels(ctx.from.id);
    if (missing.length > 0) {
        const buttons = SHOW_CHANNELS.map((ch) => [Markup.button.url(ch.name, ch.url)]);
        buttons.push([Markup.button.callback("✅ Tekshirish", checkButtonData(code))]);
        return ctx.reply("❌ Siz hali kanallarga obuna bo'lmagansiz.", Markup.inlineKeyboard(buttons));
    }
    await ctx.reply("✅ Ajoyib! Obuna tasdiqlandi 🎉");
    const opened = await openDeepLink(ctx, code);
    if (!opened) await ctx.reply("❌ Bu qism topilmadi. «📜 Kino roʻyxati» tugmasidan foydalaning.");
});

bot.action("check_membership", async (ctx) => {
    const notSubscribed = await getMissingChannels(ctx.from.id);

    if (notSubscribed.length === 0) {
        await ctx.reply("✅ Ajoyib! Siz botdan foydalanishingiz mumkin 🎉");
    } else {
        const buttons = SHOW_CHANNELS.map((ch) => [Markup.button.url(ch.name, ch.url)]);
        buttons.push([Markup.button.callback("✅ Tekshirish", "check_membership")]);
        await ctx.reply("❌ Siz hali kanallarga obuna bo'lmagansiz.", Markup.inlineKeyboard(buttons));
    }
    await ctx.answerCbQuery();
});

// ─────────────────────────────────────────────
// VIP: FOYDALANUVCHI QISMI
// ─────────────────────────────────────────────

bot.hears(BTN.VIP, async (ctx) => {
    await sendVipScreen(ctx);
});

bot.action("vip_info", async (ctx) => {
    await ctx.answerCbQuery();
    await sendVipScreen(ctx);
});

bot.action("vip_buy", async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;

    const pending = await findPendingPayment(userId);
    if (pending) {
        return ctx.reply("⏳ Oldingi to'lovingiz hali tekshirilmoqda. Natija haqida sizga xabar beramiz.");
    }

    userStates[userId] = "waiting_for_vip_receipt";
    await ctx.reply(
        `💳 <b>VIP to'lovi</b>\n\n` +
        `💰 Summa: <b>${formatSum(VIP_PRICE)} so'm</b> (${VIP_DAYS} kun)\n` +
        `💳 Karta: <code>${esc(VIP_CARD_NUMBER)}</code>\n` +
        `👤 Karta egasi: ${esc(VIP_CARD_OWNER)}\n\n` +
        `To'lovni amalga oshirgach, <b>chek rasmini (skrinshot)</b> shu yerga yuboring. ` +
        `Admin tekshirib, VIP'ni faollashtiradi.`,
        {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([[Markup.button.callback("❌ Bekor qilish", "vip_cancel")]]),
        }
    );
});

bot.action("vip_cancel", async (ctx) => {
    if (userStates[ctx.from.id] === "waiting_for_vip_receipt") delete userStates[ctx.from.id];
    await ctx.answerCbQuery("Bekor qilindi.");
    await ctx.reply("❌ To'lov bekor qilindi.");
});

async function handleVipReceipt(ctx) {
    const userId = ctx.from.id;
    const photos = ctx.message.photo;
    const fileId = photos[photos.length - 1].file_id;

    const pending = await findPendingPayment(userId);
    if (pending) {
        delete userStates[userId];
        return ctx.reply("⏳ Oldingi to'lovingiz hali tekshirilmoqda.");
    }

    const payRef = db.collection("payments").doc();
    await payRef.set({
        userId,
        username: ctx.from.username || "",
        firstName: ctx.from.first_name || "",
        lastName: ctx.from.last_name || "",
        amount: VIP_PRICE,
        days: VIP_DAYS,
        status: "pending",
        receiptFileId: fileId,
        createdAt: admin.firestore.Timestamp.now(),
    });

    const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || "Noma'lum";
    const caption =
        `💳 <b>Yangi VIP to'lov so'rovi</b>\n\n` +
        `👤 ${esc(name)}${ctx.from.username ? " (@" + esc(ctx.from.username) + ")" : ""}\n` +
        `🆔 <code>${userId}</code>\n` +
        `💰 ${formatSum(VIP_PRICE)} so'm · ${VIP_DAYS} kun`;

    try {
        await bot.telegram.sendPhoto(ADMIN_ID, fileId, {
            caption,
            parse_mode: "HTML",
            reply_markup: Markup.inlineKeyboard([
                [
                    Markup.button.callback("✅ Tasdiqlash", `pay_ok:${payRef.id}`),
                    Markup.button.callback("❌ Rad etish", `pay_no:${payRef.id}`),
                ],
            ]).reply_markup,
        });
    } catch (err) {
        console.error("Chekni adminga yuborishda xatolik:", err.message);
        await payRef.delete().catch(() => { });
        return ctx.reply("❌ Chekni yuborishda xatolik yuz berdi. Birozdan keyin qayta urinib ko'ring.");
    }

    delete userStates[userId];
    return ctx.reply("✅ Chek qabul qilindi! Admin tekshirgach, sizga xabar yuboramiz.");
}

async function clearInlineButtons(ctx) {
    try {
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    } catch (err) {
        // xabar o'zgarmagan yoki eskirgan bo'lishi mumkin
    }
}

bot.action(/^pay_ok:(.+)$/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    await ctx.answerCbQuery();
    const payId = ctx.match[1];

    try {
        const res = await approvePayment(payId);
        if (res.status === "missing") return ctx.reply("❌ To'lov topilmadi.");
        if (res.status !== "approved") {
            await clearInlineButtons(ctx);
            return ctx.reply("ℹ️ Bu to'lov allaqachon ko'rib chiqilgan.");
        }

        await clearInlineButtons(ctx);
        await ctx.reply(`✅ Tasdiqlandi. ID ${res.userId} uchun VIP ${fmtDate(res.expiresMs)} gacha faol.`);
        try {
            await bot.telegram.sendMessage(
                res.userId,
                `🎉 <b>VIP faollashtirildi!</b>\n\n📅 Amal qilish muddati: <b>${fmtDate(res.expiresMs)}</b> gacha\n\n${vipBenefitsText()}`,
                { parse_mode: "HTML" }
            );
        } catch (err) {
            await ctx.reply("⚠️ Foydalanuvchiga xabar yuborib bo'lmadi (botni bloklagan bo'lishi mumkin), lekin VIP yoqildi.");
        }
    } catch (err) {
        console.error("pay_ok xatolik:", err);
        await ctx.reply("❌ Xatolik yuz berdi. Qayta urinib ko'ring.");
    }
});

bot.action(/^pay_no:(.+)$/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    await ctx.answerCbQuery();
    const payId = ctx.match[1];

    try {
        const res = await rejectPayment(payId);
        if (res.status === "missing") return ctx.reply("❌ To'lov topilmadi.");
        if (res.status !== "rejected") {
            await clearInlineButtons(ctx);
            return ctx.reply("ℹ️ Bu to'lov allaqachon ko'rib chiqilgan.");
        }

        await clearInlineButtons(ctx);
        await ctx.reply(`❌ Rad etildi (ID ${res.userId}).`);
        try {
            await bot.telegram.sendMessage(
                res.userId,
                "❌ To'lovingiz tasdiqlanmadi.\n\nAgar bu xato deb o'ylasangiz, admin bilan bog'laning yoki to'g'ri chek bilan qayta urinib ko'ring."
            );
        } catch (err) {
            // foydalanuvchi botni bloklagan bo'lishi mumkin
        }
    } catch (err) {
        console.error("pay_no xatolik:", err);
        await ctx.reply("❌ Xatolik yuz berdi. Qayta urinib ko'ring.");
    }
});

// ─────────────────────────────────────────────
// VIP: ADMIN BOSHQARUVI
// ─────────────────────────────────────────────

bot.hears(BTN.VIP_ADMIN, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply("❌ Siz admin emassiz!");
    const pendingSnap = await db.collection("payments").where("status", "==", "pending").get();
    const pendingLabel = pendingSnap.size > 0
        ? `⏳ Kutilayotgan to'lovlar (${pendingSnap.size})`
        : "⏳ Kutilayotgan to'lovlar";
    await ctx.reply(
        "💎 VIP boshqaruvi",
        Markup.inlineKeyboard([
            [Markup.button.callback("📊 Statistika", "vipadm_stats")],
            [Markup.button.callback(pendingLabel, "vipadm_pending:0")],
            [Markup.button.callback("📋 Faol VIP'lar", "vipadm_list")],
            [Markup.button.callback("➕ VIP berish", "vipadm_grant")],
            [Markup.button.callback("🗑 VIP olib tashlash", "vipadm_revoke")],
        ])
    );
});

// To'lov yozuvining summasi (tekin = 0; summa yozilmagan eski yozuvlar narx bo'yicha)
function paymentAmount(p) {
    if (p.free === true) return 0;
    if (p.amount === undefined || p.amount === null || p.amount === "") {
        return priceForDays(Number(p.days) || VIP_DAYS);
    }
    return parseAmount(p.amount);
}

bot.action("vipadm_stats", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    await ctx.answerCbQuery();

    const now = Date.now();
    const vipSnap = await db.collection("vips").get();
    let active = 0;
    vipSnap.forEach((d) => {
        if (tsToMs(d.data().expiresAt) > now) active++;
    });

    const paySnap = await db.collection("payments").get();
    let pending = 0, approved = 0, rejected = 0, adminGrants = 0, freeGrants = 0;
    let paidRevenue = 0, adminRevenue = 0;
    paySnap.forEach((d) => {
        const p = d.data();
        const status = String(p.status || "").trim().toLowerCase();
        if (status === "pending") pending++;
        else if (status === "approved") {
            const amount = paymentAmount(p);
            if (p.source === "admin") {
                if (amount === 0) {
                    freeGrants++;
                } else {
                    adminGrants++;
                    adminRevenue += amount;
                }
            } else {
                approved++;
                paidRevenue += amount;
            }
        } else if (status === "rejected") rejected++;
    });

    await ctx.reply(
        `📊 <b>VIP statistikasi</b>\n\n` +
        `💎 Faol VIP: <b>${active}</b> ta\n` +
        `👥 Jami VIP bo'lganlar: ${vipSnap.size} ta\n\n` +
        `⏳ Kutilayotgan to'lovlar: ${pending} ta\n` +
        `✅ Chek orqali tasdiqlangan: ${approved} ta\n` +
        `👤 Admin bergan (pullik): ${adminGrants} ta\n` +
        `🎁 Admin bergan (tekin): ${freeGrants} ta\n` +
        `❌ Rad etilgan: ${rejected} ta\n\n` +
        `💳 Chek orqali tushum: ${formatSum(paidRevenue)} so'm\n` +
        `👤 Admin bergan pullik VIP'lar: ${formatSum(adminRevenue)} so'm\n` +
        `💰 <b>Jami tushum: ${formatSum(paidRevenue + adminRevenue)} so'm</b>`,
        { parse_mode: "HTML" }
    );
});

// ── Kutilayotgan to'lovlar ro'yxati (chek qayta ko'rsatiladi, tasdiqlash/rad etish mumkin) ──
const PENDING_PAGE = 5;

bot.action(/^vipadm_pending:(\d+)$/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    await ctx.answerCbQuery();
    const offset = parseInt(ctx.match[1], 10) || 0;

    const snap = await db.collection("payments").where("status", "==", "pending").get();
    const list = snap.docs.sort((a, b) => tsToMs(a.data().createdAt) - tsToMs(b.data().createdAt));
    if (list.length === 0) return ctx.reply("✅ Kutilayotgan to'lovlar yo'q.");
    if (offset >= list.length) return ctx.reply("✅ Boshqa kutilayotgan to'lov qolmadi.");

    const page = list.slice(offset, offset + PENDING_PAGE);
    await ctx.reply(`⏳ <b>Kutilayotgan to'lovlar:</b> ${list.length} ta (${offset + 1}–${offset + page.length})`, {
        parse_mode: "HTML",
    });

    const staleLimit = Date.now() - PAYMENT_WAIT_HOURS * 60 * 60 * 1000;
    for (const doc of page) {
        const p = doc.data();
        const created = tsToMs(p.createdAt);
        const name = [p.firstName, p.lastName].filter(Boolean).join(" ") || "Noma'lum";
        const caption =
            `💳 <b>VIP to'lov so'rovi</b>${created && created < staleLimit ? " ⚠️ (24 soatdan eski)" : ""}\n\n` +
            `👤 ${esc(name)}${p.username ? " (@" + esc(p.username) + ")" : ""}\n` +
            `🆔 <code>${esc(p.userId)}</code>\n` +
            `💰 ${formatSum(paymentAmount(p))} so'm · ${Number(p.days) || VIP_DAYS} kun\n` +
            `📅 Yuborilgan: ${created ? fmtDate(created) : "noma'lum"}`;
        const kb = Markup.inlineKeyboard([
            [
                Markup.button.callback("✅ Tasdiqlash", `pay_ok:${doc.id}`),
                Markup.button.callback("❌ Rad etish", `pay_no:${doc.id}`),
            ],
        ]);
        try {
            if (p.receiptFileId) {
                await ctx.replyWithPhoto(p.receiptFileId, { caption, parse_mode: "HTML", ...kb });
            } else {
                await ctx.reply(caption + "\n\n⚠️ Chek rasmi topilmadi.", { parse_mode: "HTML", ...kb });
            }
        } catch (err) {
            console.error("Kutilayotgan to'lovni ko'rsatishda xatolik:", err.message);
            await ctx.reply(caption + "\n\n⚠️ Chek rasmini ko'rsatib bo'lmadi.", { parse_mode: "HTML", ...kb });
        }
    }

    const rest = list.length - (offset + page.length);
    if (rest > 0) {
        await ctx.reply(
            `Yana ${rest} ta to'lov bor.`,
            Markup.inlineKeyboard([[Markup.button.callback("⏭ Keyingilarini ko'rsatish", `vipadm_pending:${offset + PENDING_PAGE}`)]])
        );
    }
});

bot.action("vipadm_list", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    await ctx.answerCbQuery();

    const now = Date.now();
    const snap = await db.collection("vips").get();
    const rows = snap.docs
        .map((d) => ({ ...d.data(), userId: d.data().userId || d.id }))
        .map((v) => ({ ...v, expiresMs: tsToMs(v.expiresAt) }))
        .filter((v) => v.expiresMs > now)
        .sort((a, b) => a.expiresMs - b.expiresMs);

    if (rows.length === 0) return ctx.reply("📭 Hozircha faol VIP foydalanuvchilar yo'q.");

    // Hammasi ko'rsatiladi: uzun bo'lsa bir nechta xabarga bo'linadi
    const lines = rows.map((v, i) => {
        const left = Math.max(1, Math.ceil((v.expiresMs - now) / DAY_MS));
        return (
            `${i + 1}. ${esc(displayName(v))}${v.username ? " (@" + esc(v.username) + ")" : ""}\n` +
            `    🆔 <code>${esc(v.userId)}</code> · ${fmtDate(v.expiresMs)} gacha (${left} kun)`
        );
    });
    await sendChunks(ctx, `📋 <b>Faol VIP'lar</b> (${rows.length} ta)\n`, lines);
});

bot.action("vipadm_grant", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    await ctx.answerCbQuery();
    userStates[ctx.from.id] = "waiting_for_vip_target_grant";
    delete vipAdminTarget[ctx.from.id];
    await ctx.reply("➕ VIP beriladigan foydalanuvchining ID raqamini yoki @username'ini yuboring:");
});

bot.action("vipadm_revoke", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    await ctx.answerCbQuery();
    userStates[ctx.from.id] = "waiting_for_vip_target_revoke";
    await ctx.reply("🗑 VIP olib tashlanadigan foydalanuvchining @username yoki ID raqamini yuboring:");
});

// Kun soni tanlangach: pullik / tekin / boshqa summa
async function askVipPayType(ctx, days) {
    const adminId = ctx.from.id;
    const target = vipAdminTarget[adminId];
    if (!target) {
        delete userStates[adminId];
        return ctx.reply("❌ Foydalanuvchi tanlanmagan. «💎 VIP boshqaruvi» orqali qaytadan boshlang.");
    }
    target.days = days;
    userStates[adminId] = "waiting_for_vip_paytype";
    return ctx.reply(
        `👤 ${displayName(target)} · ${days} kun\n\nBu VIP pullikmi yoki tekin?`,
        Markup.inlineKeyboard([
            [Markup.button.callback(`💰 Pullik — ${formatSum(priceForDays(days))} so'm`, "vipp:std")],
            [Markup.button.callback("✍️ Boshqa summa", "vipp:custom")],
            [Markup.button.callback("🎁 Tekin (tushumga qo'shilmaydi)", "vipp:free")],
        ])
    );
}

async function completeManualGrant(ctx, amount) {
    const adminId = ctx.from.id;
    const target = vipAdminTarget[adminId];
    if (!target || !target.days) {
        delete userStates[adminId];
        return ctx.reply("❌ Foydalanuvchi tanlanmagan. «💎 VIP boshqaruvi» orqali qaytadan boshlang.");
    }
    const days = target.days;

    const expiresMs = await grantVipDays(target, days, "admin", amount);
    delete userStates[adminId];
    delete vipAdminTarget[adminId];

    await ctx.reply(
        `✅ ${displayName(target)} ga ${days} kunlik VIP berildi. Muddat: ${fmtDate(expiresMs)} gacha.\n` +
        (amount > 0 ? `💰 Tushumga qo'shildi: ${formatSum(amount)} so'm` : "🎁 Tekin (tushumga qo'shilmadi)")
    );
    try {
        await bot.telegram.sendMessage(
            target.userId,
            `🎁 Sizga <b>${days} kunlik 💎 VIP</b> berildi!\n\n📅 Amal qilish muddati: <b>${fmtDate(expiresMs)}</b> gacha\n\n${vipBenefitsText()}`,
            { parse_mode: "HTML" }
        );
    } catch (err) {
        await ctx.reply("⚠️ Foydalanuvchiga xabar yuborib bo'lmadi, lekin VIP yoqildi.");
    }
}

bot.action(/^vipg:(\d+)$/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    await ctx.answerCbQuery();
    if (userStates[ctx.from.id] !== "waiting_for_vip_days") return;
    await askVipPayType(ctx, parseInt(ctx.match[1], 10));
});

bot.action(/^vipp:(std|free|custom)$/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    const adminId = ctx.from.id;
    const target = vipAdminTarget[adminId];
    if (userStates[adminId] !== "waiting_for_vip_paytype" || !target || !target.days) {
        return ctx.answerCbQuery("Amal muddati o'tgan.");
    }
    await ctx.answerCbQuery();
    await clearInlineButtons(ctx);

    const kind = ctx.match[1];
    if (kind === "custom") {
        userStates[adminId] = "waiting_for_vip_amount";
        return ctx.reply("✍️ Summani so'mda yozing (masalan: 25000). Tekin uchun 0 yozing:");
    }
    try {
        await completeManualGrant(ctx, kind === "free" ? 0 : priceForDays(target.days));
    } catch (err) {
        console.error("completeManualGrant xatolik:", err);
        await ctx.reply("❌ Xatolik yuz berdi. Qayta urinib ko'ring.");
    }
});

// ─────────────────────────────────────────────
// VIDEO (admin: qism saqlash / reklama / file_id)
// ─────────────────────────────────────────────

bot.on("video", async (ctx) => {
    const userId = ctx.from.id;
    const state = userStates[userId];

    if (state === "waiting_for_vip_receipt") {
        return ctx.reply("❗️ Iltimos, to'lov chekini rasm (skrinshot) sifatida yuboring.");
    }
    if (userId !== ADMIN_ID) return ctx.reply("❌ Ushbu bo'lim faqat adminlar uchun.");

    const fileId = ctx.message.video.file_id;

    if (state === "waiting_for_film_video") {
        return finalizeFilm(ctx, fileId);
    }

    if (state === "waiting_for_edit_video") {
        return applyEditValue(ctx, fileId);
    }

    if (state === "waiting_for_adv_media") {
        const caption = ctx.message.caption || "";
        advData[userId] = { type: "video", fileId, caption };
        userStates[userId] = "waiting_for_adv_confirm";
        return ctx.reply(
            `📹 Video qabul qilindi!\n\n❓ Ushbu reklamani barcha foydalanuvchilarga yuborishni tasdiqlaysizmi?`,
            Markup.inlineKeyboard([
                [Markup.button.callback("✅ Ha, yuborish", "confirm_adv")],
                [Markup.button.callback("❌ Bekor qilish", "cancel_adv_text")],
            ])
        );
    }

    return ctx.reply(`✅ Video qabul qilindi!\n\n📁 File ID:\n<code>${fileId}</code>`, { parse_mode: "HTML" });
});

// ─────────────────────────────────────────────
// RASM (to'lov cheki / admin reklamasi)
// ─────────────────────────────────────────────

bot.on("photo", async (ctx) => {
    const userId = ctx.from.id;

    if (userStates[userId] === "waiting_for_vip_receipt") {
        try {
            return await handleVipReceipt(ctx);
        } catch (err) {
            console.error("handleVipReceipt xatolik:", err);
            return ctx.reply("❌ Xatolik yuz berdi. Qayta urinib ko'ring.");
        }
    }

    if (userId !== ADMIN_ID) return;

    if (userStates[userId] === "waiting_for_adv_media") {
        const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        const caption = ctx.message.caption || "";
        advData[userId] = { type: "photo", fileId, caption };
        userStates[userId] = "waiting_for_adv_confirm";

        return ctx.reply(
            `🖼 Rasm qabul qilindi!\n\n❓ Ushbu reklamani barcha foydalanuvchilarga yuborishni tasdiqlaysizmi?`,
            Markup.inlineKeyboard([
                [Markup.button.callback("✅ Ha, yuborish", "confirm_adv")],
                [Markup.button.callback("❌ Bekor qilish", "cancel_adv_text")],
            ])
        );
    }
});

bot.on("document", async (ctx) => {
    if (userStates[ctx.from.id] === "waiting_for_vip_receipt") {
        return ctx.reply("❗️ Iltimos, chekni fayl emas, rasm (skrinshot) sifatida yuboring.");
    }
});

bot.on("animation", async (ctx) => {
    const userId = ctx.from.id;
    if (userId !== ADMIN_ID) return;

    if (userStates[userId] === "waiting_for_adv_media") {
        const fileId = ctx.message.animation.file_id;
        const caption = ctx.message.caption || "";
        advData[userId] = { type: "animation", fileId, caption };
        userStates[userId] = "waiting_for_adv_confirm";

        return ctx.reply(
            `🎞 GIF qabul qilindi!\n\n❓ Ushbu reklamani barcha foydalanuvchilarga yuborishni tasdiqlaysizmi?`,
            Markup.inlineKeyboard([
                [Markup.button.callback("✅ Ha, yuborish", "confirm_adv")],
                [Markup.button.callback("❌ Bekor qilish", "cancel_adv_text")],
            ])
        );
    }
});

// ─────────────────────────────────────────────
// ADMIN TUGMALARI
// ─────────────────────────────────────────────

bot.hears(BTN.ADV, async (ctx) => {
    const userId = ctx.from.id;
    if (userId !== ADMIN_ID) return ctx.reply("❌ Siz admin emassiz!");

    userStates[userId] = "waiting_for_adv_media";
    await ctx.reply(
        "📢 *Reklama yuborish*\n\nReklama postini yuboring:\n\n• 📝 Matn\n• 🖼 Rasm (caption bilan yoki sutsiz)\n• 📹 Video (caption bilan yoki sutsiz)\n• 🎞 GIF\n\n_HTML teglari ishlaydi: <b>bold</b>, <i>italic</i>, <a href='url'>link</a>_\n\n💎 VIP foydalanuvchilarga reklama yuborilmaydi.",
        { parse_mode: "Markdown" }
    );
});

bot.hears([BTN.COUNT, LEGACY_COUNT_BTN], async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply("❌ Siz admin emassiz!");
    await showBotStats(ctx);
});

bot.action("stats_refresh", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    await ctx.answerCbQuery("Yangilandi");
    await showBotStats(ctx);
});

bot.hears(BTN.CHANNELS, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply("❌ Siz admin emassiz!");
    await ctx.reply(
        "📡 Majburiy obuna kanallarini boshqarish",
        Markup.inlineKeyboard([
            [Markup.button.callback("📋 Ro'yxat", "channels_list")],
            [Markup.button.callback("➕ Kanal qo'shish", "channels_add")],
            [Markup.button.callback("🗑 Kanal o'chirish", "channels_remove_menu")],
        ])
    );
});

bot.action("channels_list", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    await ctx.answerCbQuery();
    if (CHECK_CHANNELS.length === 0) return ctx.reply("📭 Hozircha majburiy kanallar yo'q.");
    let msg = "📋 *Majburiy kanallar ro'yxati:*\n";
    CHECK_CHANNELS.forEach((id, i) => {
        const show = SHOW_CHANNELS[i];
        msg += `\n${i + 1}. ${(show && show.name) || id} — \`${id}\``;
    });
    await ctx.reply(msg, { parse_mode: "Markdown" });
});

bot.action("channels_add", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    await ctx.answerCbQuery();
    userStates[ctx.from.id] = "waiting_for_channel_add";
    await ctx.reply(
        "➕ *Yangi kanal qo'shish*\n\nKanalning username'ini yuboring (masalan: @kanal_nomi).\n\n⚠️ Botni avval o'sha kanalga *admin* qilib qo'shing, aks holda obuna tekshiruvi ishlamaydi.",
        { parse_mode: "Markdown" }
    );
});

bot.action("channels_remove_menu", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    await ctx.answerCbQuery();
    const snapshot = await db.collection("channels").get();
    if (snapshot.empty) return ctx.reply("📭 Hozircha majburiy kanallar yo'q.");
    const buttons = snapshot.docs.map((doc) => {
        const data = doc.data();
        return [Markup.button.callback(`🗑 ${data.name || data.channelId}`, `remove_channel:${doc.id}`)];
    });
    await ctx.reply("O'chirmoqchi bo'lgan kanalni tanlang:", Markup.inlineKeyboard(buttons));
});

bot.action(/^remove_channel:(.+)$/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    const docId = ctx.match[1];
    await db.collection("channels").doc(docId).delete();
    await loadChannels();
    await ctx.answerCbQuery("✅ O'chirildi.");
    await ctx.reply("✅ Kanal o'chirildi.");
});

// ── Yuklab olish ruxsati (videoni himoyasiz olish; VIP'dan alohida) ──

bot.hears(BTN.DOWNLOAD, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply("❌ Siz admin emassiz!");
    await ctx.reply(
        "⭐ Videoni himoyasiz (yuklab olish/forward qilish mumkin) holatda oladigan foydalanuvchilar",
        Markup.inlineKeyboard([
            [Markup.button.callback("📋 Ro'yxat", "dl_list")],
            [Markup.button.callback("➕ Foydalanuvchi qo'shish", "dl_add")],
            [Markup.button.callback("🗑 Foydalanuvchi o'chirish", "dl_remove_menu")],
        ])
    );
});

bot.action("dl_list", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    await ctx.answerCbQuery();
    if (DOWNLOAD_USERNAMES.size === 0) return ctx.reply("📭 Hozircha ruxsat berilgan foydalanuvchilar yo'q.");
    const list = [...DOWNLOAD_USERNAMES].map((u, i) => `${i + 1}. @${u}`).join("\n");
    await ctx.reply(`⭐ Ruxsat berilgan foydalanuvchilar:\n\n${list}`);
});

bot.action("dl_add", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    await ctx.answerCbQuery();
    userStates[ctx.from.id] = "waiting_for_dl_add";
    await ctx.reply("➕ Foydalanuvchi username'ini yuboring (masalan: @username):");
});

bot.action("dl_remove_menu", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    await ctx.answerCbQuery();
    if (DOWNLOAD_USERNAMES.size === 0) return ctx.reply("📭 Hozircha ruxsat berilgan foydalanuvchilar yo'q.");
    const buttons = [...DOWNLOAD_USERNAMES].map((u) => [Markup.button.callback(`🗑 @${u}`, `remove_dl:${u}`)]);
    await ctx.reply("O'chirmoqchi bo'lgan foydalanuvchini tanlang:", Markup.inlineKeyboard(buttons));
});

bot.action(/^remove_dl:(.+)$/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    const uname = ctx.match[1];
    await db.collection("vipUsers").doc(uname).delete();
    await loadDownloadUsers();
    await ctx.answerCbQuery("✅ O'chirildi.");
    await ctx.reply(`✅ @${uname} ro'yxatdan o'chirildi.`);
});

// ── Drama / qism qo'shish ──

bot.hears(BTN.ADD_DRAMA, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply("❌ Siz admin emassiz!");
    delete episodeTemplates[ctx.from.id];
    userStates[ctx.from.id] = "waiting_for_film_code";
    filmDrafts[ctx.from.id] = {};
    await ctx.reply(
        "🎬 *Yangi drama qo'shish*\n\nAvval kino kodini yuboring (masalan: 0001). Foydalanuvchilar shu kod orqali kinoni topadi.",
        { parse_mode: "Markdown" }
    );
});

bot.hears(BTN.ADD_EP, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply("❌ Siz admin emassiz!");
    delete episodeTemplates[ctx.from.id];
    delete filmDrafts[ctx.from.id];
    userStates[ctx.from.id] = "waiting_for_ep_base";
    await ctx.reply(
        "➕ *Yangi qism qo'shish*\n\nShu dramaning avval qo'shilgan istalgan qismi kodini yuboring (masalan, 1-qism kodi). Ma'lumotlar o'sha qismdan nusxalanadi.",
        {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("❌ Bekor qilish", "film_cancel")]]),
        }
    );
});

bot.action("film_skip", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    const state = userStates[ctx.from.id];
    await ctx.answerCbQuery();
    if (!state || !state.startsWith("waiting_for_film_")) return;
    const key = state.replace("waiting_for_film_", "");
    const idx = FILM_OPTIONAL_STEPS.findIndex((s) => s.key === key);
    if (idx === -1) return;
    await askFilmStep(ctx, idx + 1);
});

bot.action("film_cancel", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    delete userStates[ctx.from.id];
    delete filmDrafts[ctx.from.id];
    delete episodeTemplates[ctx.from.id];
    await ctx.answerCbQuery("Bekor qilindi.");
    await ctx.reply("❌ Qo'shish bekor qilindi.");
});

bot.action("film_overwrite_yes", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    await ctx.answerCbQuery();
    userStates[ctx.from.id] = "waiting_for_film_title";
    await ctx.reply(
        "🎬 Endi drama nomini yuboring:",
        Markup.inlineKeyboard([[Markup.button.callback("❌ Bekor qilish", "film_cancel")]])
    );
});

bot.action("film_overwrite_no", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    await ctx.answerCbQuery();
    userStates[ctx.from.id] = "waiting_for_film_code";
    filmDrafts[ctx.from.id] = {};
    await ctx.reply("🔁 Yangi kino kodini yuboring:");
});

async function pickAudience(ctx, vipOnly) {
    const userId = ctx.from.id;
    if (userId !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    if (userStates[userId] !== "waiting_for_film_audience" || !filmDrafts[userId]) {
        return ctx.answerCbQuery("Amal muddati o'tgan.");
    }
    await ctx.answerCbQuery();
    filmDrafts[userId].vipOnly = vipOnly;
    await askVideo(ctx);
}

bot.action("aud_vip", (ctx) => pickAudience(ctx, true));
bot.action("aud_all", (ctx) => pickAudience(ctx, false));

bot.action("ep_autocode", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    if (userStates[ctx.from.id] !== "waiting_for_ep_code") return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    await acceptEpisodeCode(ctx, await getNextCode());
});

bot.action("ep_num_suggest", async (ctx) => {
    const userId = ctx.from.id;
    if (userId !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    const draft = filmDrafts[userId];
    if (userStates[userId] !== "waiting_for_ep_number" || !draft) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const n = draft.suggestedEp;
    await acceptEpisodeNumber(ctx, n, `${n}-qism`);
});

bot.action("ep_next", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    if (!episodeTemplates[ctx.from.id]) return ctx.answerCbQuery("Amal muddati o'tgan.");
    await ctx.answerCbQuery();
    await askNextEpisode(ctx);
});

bot.action("ep_open_all", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    const tpl = episodeTemplates[ctx.from.id];
    if (!tpl) return ctx.answerCbQuery("Amal muddati o'tgan.");
    await ctx.answerCbQuery();
    try {
        const opened = await openAllEpisodes(tpl.dramaId);
        invalidateDramaCache();
        opened.forEach((o) => enqueueNotify(o, "opened"));
        await ctx.reply(
            opened.length > 0
                ? `🔓 ${opened.length} ta qism hammaga ochildi.${NOTIFY_ENABLED ? "\n🔔 Foydalanuvchilarga xabarnoma navbatga qo'yildi." : ""}`
                : "ℹ️ VIP uchun yopiq qism qolmagan."
        );
    } catch (err) {
        console.error("openAllEpisodes xatolik:", err);
        await ctx.reply("❌ Xatolik yuz berdi. Qayta urinib ko'ring.");
    }
});

bot.action("ep_finish", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    delete episodeTemplates[ctx.from.id];
    delete userStates[ctx.from.id];
    delete filmDrafts[ctx.from.id];
    await ctx.answerCbQuery("Tugatildi.");
    await ctx.reply("✅ Qismlar qo'shish yakunlandi.");
});

// ─────────────────────────────────────────────
// KINO RO'YXATI / IZLASH
// ─────────────────────────────────────────────

const DRAMAS_PER_PAGE = 10;       // ro'yxatning bitta sahifasidagi dramalar
const EPISODES_PER_PAGE = 30;     // bitta sahifadagi qism tugmalari (Telegram limiti: 100)
const EP_BUTTONS_PER_ROW = 3;     // bir qatordagi qism tugmalari
const SEARCH_LIMIT = 20;          // izlashda ko'rsatiladigan dramalar soni
const DRAMA_CACHE_MS = 2 * 60 * 1000;

let dramaCache = { at: 0, groups: null };

function invalidateDramaCache() {
    dramaCache = { at: 0, groups: null };
}

// Izlash/guruhlash uchun matnni soddalashtirish: kichik harf, apostrof va belgilarsiz
function normalizeText(s) {
    return String(s || "")
        .toLowerCase()
        .replace(/[ʻʼ'’‘`´]/g, "")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .replace(/\s+/g, " ");
}

function dramaKey(title) {
    return normalizeText(title) || "nomsiz";
}

function epLabel(e) {
    return e.episode || (e.epNo ? `${e.epNo}-qism` : "Kino");
}

function shorten(s, max) {
    s = String(s || "");
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// callback_data limiti: 64 bayt
function cbFits(data) {
    return Buffer.byteLength(data, "utf8") <= 64;
}

// Deep link (t.me/bot?start=...) faqat shu belgilarni qabul qiladi
function isDeepLinkSafe(s) {
    return /^[A-Za-z0-9_-]{1,64}$/.test(String(s || ""));
}

function botUsername(ctx) {
    return (ctx && ctx.botInfo && ctx.botInfo.username) || (bot.botInfo && bot.botInfo.username) || "";
}

// Qismlarni drama nomi bo'yicha guruhlaydi (2 daqiqa keshlanadi)
async function loadDramaGroups(force = false) {
    if (!force && dramaCache.groups && Date.now() - dramaCache.at < DRAMA_CACHE_MS) {
        return dramaCache.groups;
    }

    const snap = await db.collection("films").get();
    const groups = new Map();
    const INFO_FIELDS = ["year", "genre", "translator", "language", "description"];

    snap.forEach((doc) => {
        const d = doc.data();
        const title = String(d.title || "").trim() || "Nomsiz";
        const key = dramaKey(title);
        if (!groups.has(key)) groups.set(key, { title, info: {}, eps: [] });
        const g = groups.get(key);
        INFO_FIELDS.forEach((f) => {
            if (!g.info[f] && d[f]) g.info[f] = String(d[f]);
        });
        g.eps.push({
            code: doc.id,
            episode: d.episode || "",
            epNo: typeof d.epNo === "number" ? d.epNo : parseEpNo(d.episode),
            vipOnly: d.vipOnly === true,
        });
    });

    const byCode = (a, b) => a.code.localeCompare(b.code, undefined, { numeric: true });
    const list = [...groups.values()];
    list.forEach((g) => {
        g.eps.sort((a, b) => {
            const x = a.epNo === null ? Infinity : a.epNo;
            const y = b.epNo === null ? Infinity : b.epNo;
            return (x === y ? 0 : x - y) || byCode(a, b);
        });
        // Barqaror kalit: dramaning eng kichik kodi
        g.key = [...g.eps].sort(byCode)[0].code;
    });
    list.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true }));

    dramaCache = { at: Date.now(), groups: list };
    return list;
}

function findGroupByCode(groups, code) {
    return groups.find((g) => g.eps.some((e) => e.code === code)) || null;
}

function epPageOf(group, code) {
    const idx = group.eps.findIndex((e) => e.code === code);
    return idx < 0 ? 0 : Math.floor(idx / EPISODES_PER_PAGE);
}

function dramaCallback(groups, group, epPage) {
    const data = `dr:${group.key}:${epPage}`;
    return cbFits(data) ? data : `dri:${groups.indexOf(group)}:${epPage}`;
}

// Callback orqali kelsa xabarni tahrirlaydi, aks holda (yoki video xabar bo'lsa) yangi xabar yuboradi
async function showOrEdit(ctx, text, keyboard) {
    const extra = { parse_mode: "HTML", ...Markup.inlineKeyboard(keyboard) };
    if (ctx.callbackQuery && ctx.callbackQuery.message && ctx.callbackQuery.message.text) {
        try {
            return await ctx.editMessageText(text, extra);
        } catch (err) {
            const msg = String((err.response && err.response.description) || err.message);
            if (msg.includes("message is not modified")) return;
        }
    }
    return ctx.reply(text, extra);
}

async function showDramaPage(ctx, page) {
    const groups = await loadDramaGroups();
    if (groups.length === 0) return ctx.reply("❌ Hozircha bazaga hech qanday drama qo'shilmagan.");

    const pages = Math.ceil(groups.length / DRAMAS_PER_PAGE);
    page = Math.min(Math.max(0, page || 0), pages - 1);
    const start = page * DRAMAS_PER_PAGE;

    const keyboard = groups.slice(start, start + DRAMAS_PER_PAGE).map((g) => {
        let label = `🎬 ${shorten(g.title, 50)}`;
        if (g.eps.some((e) => e.vipOnly)) label += " 💎";
        return [Markup.button.callback(label, dramaCallback(groups, g, 0))];
    });

    if (pages > 1) {
        const nav = [];
        if (page > 0) nav.push(Markup.button.callback("⬅️", `drpg:${page - 1}`));
        nav.push(Markup.button.callback(`${page + 1} / ${pages}`, "drpg_noop"));
        if (page < pages - 1) nav.push(Markup.button.callback("➡️", `drpg:${page + 1}`));
        keyboard.push(nav);
    }

    let text = `🎬 <b>SeoulFlix Drama Ro'yxati</b>\n\n📚 Jami: ${groups.length} ta drama`;
    if (groups.some((g) => g.eps.some((e) => e.vipOnly))) text += "\n💎 — VIP uchun yangi qismlari bor";
    text += "\n\nKerakli dramani tanlang 👇";
    return showOrEdit(ctx, text, keyboard);
}

async function showDramaEpisodes(ctx, groups, group, epPage) {
    const total = group.eps.length;
    const pages = Math.max(1, Math.ceil(total / EPISODES_PER_PAGE));
    epPage = Math.min(Math.max(0, epPage || 0), pages - 1);
    const slice = group.eps.slice(epPage * EPISODES_PER_PAGE, (epPage + 1) * EPISODES_PER_PAGE);

    let text = `🎬 <b>${esc(group.title)}</b>\n`;
    const meta = [];
    if (group.info.year) meta.push(`🗓 ${esc(group.info.year)}`);
    if (group.info.genre) meta.push(`📄 ${esc(group.info.genre)}`);
    if (group.info.language) meta.push(`🌐 ${esc(group.info.language)}`);
    if (group.info.translator) meta.push(`🎧 ${esc(group.info.translator)}`);
    if (meta.length) text += meta.join(" · ") + "\n";
    if (group.info.description) text += `\n📕 ${esc(shorten(group.info.description, 350))}\n`;
    text += `\n📺 Qismlar: <b>${total}</b> ta`;
    if (pages > 1) text += ` (${epPage + 1}/${pages}-sahifa)`;
    if (group.eps.some((e) => e.vipOnly)) text += "\n💎 — hozircha faqat VIP uchun";
    text += "\n\nKo'rmoqchi bo'lgan qismni tanlang 👇";

    const keyboard = [];
    let row = [];
    const leftovers = [];
    for (const e of slice) {
        const data = `ep:${e.code}`;
        if (!cbFits(data)) {
            leftovers.push(e);
            continue;
        }
        row.push(Markup.button.callback(`${e.vipOnly ? "💎" : "▶️"} ${shorten(epLabel(e), 25)}`, data));
        if (row.length === EP_BUTTONS_PER_ROW) {
            keyboard.push(row);
            row = [];
        }
    }
    if (row.length) keyboard.push(row);

    // Juda uzun kodli qismlar tugmaga sig'maydi: kodini matnda ko'rsatamiz
    if (leftovers.length) {
        text += "\n";
        leftovers.forEach((e) => {
            text += `\n🎞 ${esc(epLabel(e))} — Kod: <code>${esc(e.code)}</code>`;
        });
    }

    if (pages > 1) {
        const nav = [];
        if (epPage > 0) nav.push(Markup.button.callback("⬅️ Oldingi", dramaCallback(groups, group, epPage - 1)));
        nav.push(Markup.button.callback(`${epPage + 1} / ${pages}`, "drpg_noop"));
        if (epPage < pages - 1) nav.push(Markup.button.callback("Keyingi ➡️", dramaCallback(groups, group, epPage + 1)));
        keyboard.push(nav);
    }

    const listPage = Math.max(0, Math.floor(groups.indexOf(group) / DRAMAS_PER_PAGE));
    keyboard.push([Markup.button.callback("⬅️ Ortga", `drpg:${listPage}`)]);

    return showOrEdit(ctx, text, keyboard);
}

// Nomi bo'yicha izlash: so'rovdagi barcha so'zlar drama nomida bo'lishi kerak
function searchDramas(groups, query) {
    const q = normalizeText(query);
    if (q.length < 2) return [];
    const tokens = q.split(" ");
    return groups
        .map((g) => ({ g, t: dramaKey(g.title) }))
        .filter(({ t }) => tokens.every((tok) => t.includes(tok)))
        .sort((a, b) => {
            const rank = (t) => (t === q ? 0 : t.startsWith(q) ? 1 : t.includes(q) ? 2 : 3);
            return rank(a.t) - rank(b.t) || a.g.title.localeCompare(b.g.title);
        })
        .map(({ g }) => g);
}

async function showSearchResults(ctx, groups, matches, query) {
    if (matches.length === 1) return showDramaEpisodes(ctx, groups, matches[0], 0);

    const shown = matches.slice(0, SEARCH_LIMIT);
    const keyboard = shown.map((g) => {
        let label = `🎬 ${shorten(g.title, 50)}`;
        if (g.eps.some((e) => e.vipOnly)) label += " 💎";
        return [Markup.button.callback(label, dramaCallback(groups, g, 0))];
    });
    let text = `🔎 «${esc(shorten(query, 50))}» bo'yicha <b>${matches.length}</b> ta drama topildi:`;
    if (matches.length > SEARCH_LIMIT) text += `\n\nℹ️ Birinchi ${SEARCH_LIMIT} tasi ko'rsatildi. Aniqroq yozing.`;
    return ctx.reply(text, { parse_mode: "HTML", ...Markup.inlineKeyboard(keyboard) });
}

// Qismni yuborish (kod, tugma, navigatsiya va havola uchun yagona funksiya).
// Kod bo'yicha qism topilmasa false qaytaradi.
async function sendEpisode(ctx, code) {
    const userId = ctx.from.id;
    if (!isValidCode(code)) return false;
    const filmDoc = await db.collection("films").doc(code).get();
    if (!filmDoc.exists) return false;
    const film = filmDoc.data();

    let groups = await loadDramaGroups();
    let group = findGroupByCode(groups, code);
    if (!group) {
        // yangi qo'shilgan qism keshda bo'lmasligi mumkin
        groups = await loadDramaGroups(true);
        group = findGroupByCode(groups, code);
    }
    const allBtn = group
        ? Markup.button.callback("📜 Barcha qismlar", dramaCallback(groups, group, epPageOf(group, code)))
        : null;

    // VIP uchun yopiq qism
    if (film.vipOnly === true && !(await hasVipAccess(userId))) {
        const kb = [[Markup.button.callback("💎 VIP haqida", "vip_info")]];
        if (allBtn) kb.push([allBtn]);
        await ctx.reply(
            `🔒 <b>${esc(film.title || "Drama")}</b>${film.episode ? " · " + esc(film.episode) : ""}\n\n` +
            `Bu qism hozircha <b>faqat VIP</b> foydalanuvchilar uchun.\n` +
            `⏳ Oddiy foydalanuvchilar uchun u keyinroq ochiladi.\n\n` +
            `💎 VIP bilan yangi qismlarni ${VIP_AHEAD} qism oldin va reklamasiz ko'ring!`,
            { parse_mode: "HTML", ...Markup.inlineKeyboard(kb) }
        );
        return true;
    }

    // Video ostidagi tugmalar: oldingi / keyingi qism, barcha qismlar, ulashish
    const keyboard = [];
    if (group) {
        const i = group.eps.findIndex((e) => e.code === code);
        const prev = i > 0 ? group.eps[i - 1] : null;
        const next = i >= 0 && i < group.eps.length - 1 ? group.eps[i + 1] : null;
        const nav = [];
        if (prev && cbFits(`ep:${prev.code}`)) {
            nav.push(Markup.button.callback(`⬅️ ${prev.vipOnly ? "💎 " : ""}${shorten(epLabel(prev), 20)}`, `ep:${prev.code}`));
        }
        if (next && cbFits(`ep:${next.code}`)) {
            nav.push(Markup.button.callback(`${next.vipOnly ? "💎 " : ""}${shorten(epLabel(next), 20)} ➡️`, `ep:${next.code}`));
        }
        if (nav.length) keyboard.push(nav);
        keyboard.push([allBtn]);
    }
    const uname = botUsername(ctx);
    if (uname && isDeepLinkSafe(code)) {
        const link = `https://t.me/${uname}?start=${code}`;
        const shareText = [film.title, film.episode].filter(Boolean).join(" · ");
        keyboard.push([
            Markup.button.url(
                "📤 Do'stlarga ulashish",
                `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(shareText)}`
            ),
        ]);
    }

    try {
        await incrementViewCount(code);
        const updatedViews = (film.views || 0) + 1;
        const requesterUsername = (ctx.from.username || "").toLowerCase();
        const canDownload = DOWNLOAD_USERNAMES.has(requesterUsername);

        await ctx.replyWithVideo(film.video_link, {
            caption: buildCaption(film, updatedViews),
            parse_mode: "HTML",
            protect_content: !canDownload,
            ...(keyboard.length ? Markup.inlineKeyboard(keyboard) : {}),
        });

        // Admin uchun: kanal postiga qo'yish uchun tayyor havolalar
        if (userId === ADMIN_ID && uname && isDeepLinkSafe(code)) {
            let links = `🔗 Qism havolasi:\n<code>https://t.me/${uname}?start=${esc(code)}</code>`;
            if (group && isDeepLinkSafe(`dr_${group.key}`)) {
                links += `\n\n📜 Barcha qismlar havolasi:\n<code>https://t.me/${uname}?start=dr_${esc(group.key)}</code>`;
            }
            await ctx.reply(links, {
                parse_mode: "HTML",
                ...(cbFits(`edm:${code}`)
                    ? Markup.inlineKeyboard([[Markup.button.callback("✏️ Tahrirlash / o'chirish", `edm:${code}`)]])
                    : {}),
            });
        }
    } catch (err) {
        console.error("Video yuborishda xatolik:", err.message);
        await ctx.reply("❌ Video yuborishda xatolik yuz berdi.");
    }
    return true;
}

// Havola orqali kelganda: "0012" -> qism, "dr_0012" -> dramaning barcha qismlari
async function openDeepLink(ctx, payload) {
    if (await sendEpisode(ctx, payload)) return true;
    if (payload.startsWith("dr_")) {
        const groups = await loadDramaGroups(true);
        const group = findGroupByCode(groups, payload.slice(3));
        if (group) {
            await showDramaEpisodes(ctx, groups, group, 0);
            return true;
        }
    }
    return false;
}

bot.hears(BTN.LIST, async (ctx) => {
    const subscribed = await checkSubscription(ctx);
    if (!subscribed) return;
    await showDramaPage(ctx, 0);
});

bot.action(/^drpg:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await showDramaPage(ctx, parseInt(ctx.match[1], 10));
});

bot.action("drpg_noop", (ctx) => ctx.answerCbQuery());

async function openGroupFromCallback(ctx, finder, epPage) {
    const groups = await loadDramaGroups();
    const group = finder(groups);
    if (!group) {
        await ctx.answerCbQuery("❌ Drama topilmadi.");
        return showDramaPage(ctx, 0);
    }
    await ctx.answerCbQuery();
    return showDramaEpisodes(ctx, groups, group, epPage);
}

bot.action(/^dr:(.+):(\d+)$/, (ctx) => {
    const code = ctx.match[1];
    return openGroupFromCallback(ctx, (groups) => findGroupByCode(groups, code), parseInt(ctx.match[2], 10));
});

bot.action(/^dri:(\d+):(\d+)$/, (ctx) => {
    const idx = parseInt(ctx.match[1], 10);
    return openGroupFromCallback(ctx, (groups) => groups[idx] || null, parseInt(ctx.match[2], 10));
});

// Qism tugmasi yoki video ostidagi oldingi/keyingi tugmasi
bot.action(/^ep:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const subscribed = await checkSubscription(ctx, ctx.match[1]);
    if (!subscribed) return;
    const sent = await sendEpisode(ctx, ctx.match[1]);
    if (!sent) await ctx.reply("❌ Bu qism topilmadi (o'chirilgan bo'lishi mumkin).");
});

bot.hears(BTN.SEARCH, async (ctx) => {
    const subscribed = await checkSubscription(ctx);
    if (!subscribed) return;
    ctx.reply("🔎 Drama kodini yoki nomini yozing 👇\n\nMasalan: <code>0001</code> yoki drama nomining bir qismi.", { parse_mode: "HTML" });
});

// ─────────────────────────────────────────────
// YANGI QISM XABARNOMALARI (foydalanuvchilarga avtomatik)
// ─────────────────────────────────────────────

// dramaKey -> { title, all: Map, vip: Map, opened: Map, timer }
//   all    — hamma uchun yangi qism (hammaga yuboriladi)
//   vip    — faqat VIP uchun yangi qism (faqat faol VIP'larga)
//   opened — VIP'dan hammaga ochilgan qism (VIP bo'lmaganlarga)
const notifyQueue = new Map();
let broadcastChain = Promise.resolve(); // xabarnomalar ketma-ket yuboriladi (Telegram limiti uchun)

function epSort(a, b) {
    const x = typeof a.epNo === "number" ? a.epNo : Infinity;
    const y = typeof b.epNo === "number" ? b.epNo : Infinity;
    return (x === y ? 0 : x - y) || String(a.code).localeCompare(String(b.code), undefined, { numeric: true });
}

function findQueueKeyByCode(code) {
    for (const [key, e] of notifyQueue) {
        if (e.all.has(code) || e.vip.has(code) || e.opened.has(code)) return key;
    }
    return null;
}

function enqueueNotify(ep, kind) {
    if (!NOTIFY_ENABLED || !ep || !ep.code) return;
    const key = dramaKey(ep.title);
    let entry = notifyQueue.get(key);
    if (!entry) {
        entry = { title: ep.title || "Nomsiz", all: new Map(), vip: new Map(), opened: new Map(), timer: null };
        notifyQueue.set(key, entry);
    }

    if (kind === "opened" && (entry.vip.has(ep.code) || entry.all.has(ep.code))) {
        // hali xabar berilmagan VIP qism hammaga ochildi: hamma uchun yangi qism sifatida yuboriladi
        entry.vip.delete(ep.code);
        entry.all.set(ep.code, ep);
    } else {
        entry.all.delete(ep.code);
        entry.vip.delete(ep.code);
        entry.opened.delete(ep.code);
        entry[kind].set(ep.code, ep);
    }

    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => flushNotify(key), NOTIFY_DELAY_MIN * 60 * 1000);
}

function removeFromNotify(code) {
    const key = findQueueKeyByCode(code);
    if (!key) return;
    const e = notifyQueue.get(key);
    e.all.delete(code);
    e.vip.delete(code);
    e.opened.delete(code);
    if (e.all.size + e.vip.size + e.opened.size === 0) {
        clearTimeout(e.timer);
        notifyQueue.delete(key);
    }
}

function flushNotify(key) {
    const entry = notifyQueue.get(key);
    if (!entry) return false;
    clearTimeout(entry.timer);
    notifyQueue.delete(key);
    broadcastChain = broadcastChain
        .then(() => runNotify(entry))
        .catch((err) => console.error("Xabarnoma xatolik:", err));
    return true;
}

async function sendWithRetry(fn) {
    try {
        return await fn();
    } catch (error) {
        if (error.response && error.response.error_code === 429) {
            const wait = ((error.response.parameters && error.response.parameters.retry_after) || 1) + 1;
            await sleep(wait * 1000);
            return fn();
        }
        throw error;
    }
}

function buildNotifyMessage(groups, group, isNewDrama, newEps, openedEps, forVip) {
    const label = (e) => `${epLabel(e)}${e.vipOnly ? " 💎" : ""}`;
    let header;
    if (isNewDrama) header = "🆕 <b>Yangi drama qo'shildi!</b>";
    else if (newEps.length > 1) header = "🔔 <b>Yangi qismlar qo'shildi!</b>";
    else if (newEps.length === 1) header = "🔔 <b>Yangi qism qo'shildi!</b>";
    else header = "🔓 <b>Yangi qism hamma uchun ochildi!</b>";

    let text = `${header}\n\n🎬 <b>${esc(group.title)}</b>`;
    if (isNewDrama) {
        const meta = [];
        if (group.info.year) meta.push(`🗓 ${esc(group.info.year)}`);
        if (group.info.genre) meta.push(`📄 ${esc(group.info.genre)}`);
        if (meta.length) text += `\n${meta.join(" · ")}`;
    }
    if (newEps.length) text += `\n🎞 ${newEps.map((e) => esc(label(e))).join(", ")}`;
    if (openedEps.length) text += `\n🔓 Endi hamma uchun ochiq: ${openedEps.map((e) => esc(epLabel(e))).join(", ")}`;
    if (forVip && newEps.some((e) => e.vipOnly)) text += `\n\n💎 VIP sifatida siz uni boshqalardan oldin ko'rasiz!`;
    text += "\n\nHoziroq tomosha qiling 👇";

    const first = [...newEps, ...openedEps].sort(epSort)[0];
    const kb = [];
    if (first && cbFits(`ep:${first.code}`)) {
        kb.push([Markup.button.callback(`▶️ Ko'rish: ${shorten(epLabel(first), 25)}`, `ep:${first.code}`)]);
    }
    kb.push([Markup.button.callback("📜 Barcha qismlar", dramaCallback(groups, group, 0))]);
    kb.push([Markup.button.callback("🔕 Xabarnomalarni o'chirish", "notif_off")]);
    return { text, extra: { parse_mode: "HTML", ...Markup.inlineKeyboard(kb) } };
}

async function runNotify(entry) {
    const groups = await loadDramaGroups(true);
    const codes = [...entry.all.keys(), ...entry.vip.keys(), ...entry.opened.keys()];
    const group = groups.find((g) => g.eps.some((e) => codes.includes(e.code)));
    if (!group) return;

    // O'chirilgan qismlarni tashlab, joriy holat bo'yicha olamiz
    const byCode = new Map(group.eps.map((e) => [e.code, e]));
    const pick = (m) => [...m.keys()].filter((c) => byCode.has(c)).map((c) => byCode.get(c)).sort(epSort);
    const allEps = pick(entry.all);
    const vipEps = pick(entry.vip);
    const openedEps = pick(entry.opened);
    if (allEps.length + vipEps.length + openedEps.length === 0) return;

    const newCodes = new Set([...allEps, ...vipEps].map((e) => e.code));
    const isNewDrama = newCodes.size > 0 && group.eps.every((e) => newCodes.has(e.code));

    const vipNew = [...allEps, ...vipEps].sort(epSort);
    const vipMsg = vipNew.length ? buildNotifyMessage(groups, group, isNewDrama, vipNew, [], true) : null;
    const userMsg =
        allEps.length || openedEps.length
            ? buildNotifyMessage(groups, group, isNewDrama && allEps.length > 0, allEps, openedEps, false)
            : null;

    const [usersSnap, vipIds] = await Promise.all([db.collection("users").get(), getActiveVipIds()]);
    let success = 0, failed = 0, muted = 0;

    for (const docSnap of usersSnap.docs) {
        const u = docSnap.data();
        const uid = Number(u.userId || docSnap.id);
        if (!uid || uid === ADMIN_ID) continue;
        if (u.notifyOff === true) {
            muted++;
            continue;
        }
        const msg = vipIds.has(String(uid)) ? vipMsg : userMsg;
        if (!msg) continue;

        try {
            await sendWithRetry(() => bot.telegram.sendMessage(uid, msg.text, msg.extra));
            success++;
        } catch (error) {
            if (error.response && error.response.error_code === 403) {
                await docSnap.ref.delete().catch(() => { });
            }
            failed++;
        }
        await sleep(40);
    }

    const list = [...vipNew, ...openedEps].sort(epSort).map((e) => epLabel(e)).join(", ");
    await bot.telegram
        .sendMessage(
            ADMIN_ID,
            `🔔 <b>Xabarnoma yuborildi</b>\n\n🎬 ${esc(group.title)}\n🎞 ${esc(list)}\n\n` +
            `🟢 Yuborildi: ${success} ta\n🔴 Xatolik: ${failed} ta\n🔕 O'chirib qo'yganlar: ${muted} ta`,
            { parse_mode: "HTML" }
        )
        .catch(() => { });
}

bot.action(/^ntf_now:(.+)$/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    const key = findQueueKeyByCode(ctx.match[1]);
    if (!key) return ctx.answerCbQuery("ℹ️ Bu xabarnoma allaqachon yuborilgan yoki bekor qilingan.", { show_alert: true });
    flushNotify(key);
    await ctx.answerCbQuery("📣 Yuborilmoqda...");
    await ctx.reply("📣 Xabarnoma yuborilmoqda. Tugagach hisobot keladi.");
});

bot.action(/^ntf_cancel:(.+)$/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    const key = findQueueKeyByCode(ctx.match[1]);
    if (!key) return ctx.answerCbQuery("ℹ️ Bu xabarnoma allaqachon yuborilgan yoki bekor qilingan.", { show_alert: true });
    const e = notifyQueue.get(key);
    clearTimeout(e.timer);
    notifyQueue.delete(key);
    await ctx.answerCbQuery("🔕 Bekor qilindi");
    await ctx.reply(`🔕 «${e.title}» bo'yicha xabarnoma bu safar yuborilmaydi.`);
});

// Foydalanuvchi: xabarnomalarni o'chirish / yoqish
bot.action("notif_off", async (ctx) => {
    await db.collection("users").doc(String(ctx.from.id)).set({ notifyOff: true }, { merge: true });
    await ctx.answerCbQuery("🔕 O'chirildi");
    await ctx.reply(
        "🔕 Yangi qismlar haqidagi xabarnomalar o'chirildi.",
        Markup.inlineKeyboard([[Markup.button.callback("🔔 Qayta yoqish", "notif_on")]])
    );
});

bot.action("notif_on", async (ctx) => {
    await db.collection("users").doc(String(ctx.from.id)).set({ notifyOff: false }, { merge: true });
    await ctx.answerCbQuery("🔔 Yoqildi");
    await clearInlineButtons(ctx);
    await ctx.reply("🔔 Xabarnomalar yoqildi! Yangi qismlar chiqqanda sizga xabar beramiz.");
});

// ─────────────────────────────────────────────
// ADMIN: QISMNI TAHRIRLASH / O'CHIRISH
// ─────────────────────────────────────────────

const EDIT_FIELDS = {
    t: { key: "title", label: "🎬 Nomi" },
    e: { key: "episode", label: "🎞 Qism" },
    y: { key: "year", label: "🗓 Yil" },
    tr: { key: "translator", label: "🎧 Tarjimon" },
    l: { key: "language", label: "🌐 Til" },
    g: { key: "genre", label: "📄 Janr" },
    d: { key: "description", label: "📕 Tavsif" },
    v: { key: "video_link", label: "🎥 Video" },
};

async function showEditMenu(ctx, code) {
    const doc = await db.collection("films").doc(code).get();
    if (!doc.exists) return ctx.reply("❌ Bu qism topilmadi (o'chirilgan bo'lishi mumkin).");
    if (!cbFits(`eddelok:${code}`)) {
        return ctx.reply("❌ Bu qism kodi juda uzun, tugmalar orqali tahrirlab bo'lmaydi.");
    }
    const f = doc.data();
    const groups = await loadDramaGroups();
    const group = findGroupByCode(groups, code);
    const val = (v) => (v ? esc(shorten(v, 200)) : "<i>kiritilmagan</i>");

    const text =
        `✏️ <b>Qismni tahrirlash</b>\n\n` +
        `🔑 Kod: <code>${esc(code)}</code>\n` +
        `🎬 Nomi: ${val(f.title)}${group ? ` (dramada ${group.eps.length} ta qism)` : ""}\n` +
        `🎞 Qism: ${val(f.episode)}\n` +
        `🗓 Yil: ${val(f.year)}\n` +
        `🎧 Tarjimon: ${val(f.translator)}\n` +
        `🌐 Til: ${val(f.language)}\n` +
        `📄 Janr: ${val(f.genre)}\n` +
        `📕 Tavsif: ${val(f.description)}\n` +
        `👥 Kimga: ${f.vipOnly === true ? "💎 Faqat VIP" : "🌍 Hamma"}\n` +
        `👁 Ko'rilgan: ${f.views || 0} marta\n\n` +
        `O'zgartirmoqchi bo'lgan maydonni tanlang 👇`;

    const b = (k) => Markup.button.callback(EDIT_FIELDS[k].label, `ed:${k}:${code}`);
    const keyboard = [
        [b("t"), b("e")],
        [b("y"), b("tr")],
        [b("l"), b("g")],
        [b("d"), b("v")],
        [
            Markup.button.callback(
                f.vipOnly === true ? "🌍 Hamma uchun ochish" : "💎 Faqat VIP qilish",
                `edvip:${code}`
            ),
        ],
        [Markup.button.callback("▶️ Ko'rish", `ep:${code}`), Markup.button.callback("🗑 O'chirish", `eddel:${code}`)],
        [Markup.button.callback("✖️ Yopish", "edclose")],
    ];
    return showOrEdit(ctx, text, keyboard);
}

bot.hears(BTN.EDIT_EP, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply("❌ Siz admin emassiz!");
    delete editTarget[ctx.from.id];
    userStates[ctx.from.id] = "waiting_for_edit_code";
    await ctx.reply(
        "✏️ Tahrirlamoqchi yoki o'chirmoqchi bo'lgan qism kodini yuboring:\n\n" +
        "💡 Istalgan qism kodini yuborganingizda video ostida «✏️ Tahrirlash» tugmasi ham chiqadi.",
        Markup.inlineKeyboard([[Markup.button.callback("❌ Bekor qilish", "edcancel")]])
    );
});

bot.action(/^edm:(.+)$/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    await ctx.answerCbQuery();
    delete userStates[ctx.from.id];
    delete editTarget[ctx.from.id];
    await showEditMenu(ctx, ctx.match[1]);
});

bot.action(/^ed:(t|e|y|tr|l|g|d|v):(.+)$/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    await ctx.answerCbQuery();
    const field = ctx.match[1];
    const code = ctx.match[2];
    const doc = await db.collection("films").doc(code).get();
    if (!doc.exists) return ctx.reply("❌ Bu qism topilmadi.");
    const f = doc.data();

    editTarget[ctx.from.id] = { code, field };
    userStates[ctx.from.id] = field === "v" ? "waiting_for_edit_video" : "waiting_for_edit_value";

    const current = f[EDIT_FIELDS[field].key];
    let prompt;
    if (field === "t") {
        const groups = await loadDramaGroups();
        const group = findGroupByCode(groups, code);
        const n = group ? group.eps.length : 1;
        prompt = `🎬 Yangi nomni yuboring.\n\n⚠️ Butun dramaning nomi o'zgaradi (${n} ta qism).`;
    } else if (field === "e") {
        prompt = "🎞 Yangi qism raqamini yuboring (masalan: 5 yoki 5-qism).";
    } else if (field === "v") {
        prompt = "🎥 Yangi videoni video fayl sifatida yuboring.";
    } else {
        prompt = `${EDIT_FIELDS[field].label} uchun yangi qiymatni yuboring.\n\nMaydonni tozalash uchun «-» yuboring.`;
    }
    if (field !== "v") prompt += `\n\nHozirgi: ${current ? esc(shorten(current, 500)) : "<i>kiritilmagan</i>"}`;

    await ctx.reply(prompt, {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("❌ Bekor qilish", `edm:${code}`)]]),
    });
});

async function applyEditValue(ctx, value) {
    const adminId = ctx.from.id;
    const t = editTarget[adminId];
    if (!t) {
        delete userStates[adminId];
        return ctx.reply("❌ Seans tugagan. «✏️ Qismni tahrirlash» orqali qaytadan boshlang.");
    }
    const ref = db.collection("films").doc(t.code);
    const snap = await ref.get();
    if (!snap.exists) {
        delete userStates[adminId];
        delete editTarget[adminId];
        return ctx.reply("❌ Bu qism topilmadi (o'chirilgan bo'lishi mumkin).");
    }
    const field = EDIT_FIELDS[t.field];
    let note = "";

    try {
        if (t.field === "t") {
            const title = String(value).trim();
            if (!title || title === "-") return ctx.reply("❌ Nom bo'sh bo'lishi mumkin emas. Qayta yuboring:");
            if (title.length > 200) return ctx.reply("❌ Nom juda uzun (200 belgigacha). Qayta yuboring:");
            const groups = await loadDramaGroups(true);
            const group = findGroupByCode(groups, t.code);
            const codes = group ? group.eps.map((e) => e.code) : [t.code];
            for (let i = 0; i < codes.length; i += 400) {
                const batch = db.batch();
                codes.slice(i, i + 400).forEach((c) => batch.update(db.collection("films").doc(c), { title }));
                await batch.commit();
            }
            note = ` (${codes.length} ta qismda)`;
        } else if (t.field === "e") {
            const label = normalizeEpisode(value);
            const epNo = parseEpNo(label);
            if (epNo === null) return ctx.reply("❌ Qism raqami bo'lishi kerak (masalan: 5). Qayta yuboring:");
            const groups = await loadDramaGroups(true);
            const group = findGroupByCode(groups, t.code);
            const dup = group && group.eps.find((e) => e.code !== t.code && e.epNo === epNo);
            if (dup) return ctx.reply(`❌ ${epNo}-qism allaqachon bor (kod: ${dup.code}). Boshqa raqam yuboring:`);
            await ref.update({ episode: label, epNo });
        } else if (t.field === "v") {
            await ref.update({ video_link: value });
        } else {
            let v = String(value).trim();
            if (v === "-") v = "";
            if (t.field === "d" && v.length > 3000) v = v.slice(0, 3000);
            if (t.field !== "d" && v.length > 200) v = v.slice(0, 200);
            await ref.update({ [field.key]: v });
        }
    } catch (err) {
        console.error("Tahrirlashda xatolik:", err);
        return ctx.reply("❌ Saqlashda xatolik yuz berdi. Qayta urinib ko'ring.");
    }

    invalidateDramaCache();
    delete userStates[adminId];
    delete editTarget[adminId];
    await ctx.reply(`✅ ${field.label} saqlandi${note}.`);
    return showEditMenu(ctx, t.code);
}

bot.action(/^edvip:(.+)$/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    const code = ctx.match[1];
    const ref = db.collection("films").doc(code);
    const snap = await ref.get();
    if (!snap.exists) return ctx.answerCbQuery("❌ Qism topilmadi.");
    const f = snap.data();
    const makeVip = f.vipOnly !== true;

    await ref.update(
        makeVip ? { vipOnly: true } : { vipOnly: false, openedAt: admin.firestore.Timestamp.now() }
    );
    invalidateDramaCache();
    if (!makeVip) enqueueNotify({ code, episode: f.episode, epNo: f.epNo, title: f.title }, "opened");

    await ctx.answerCbQuery(
        makeVip
            ? "💎 Endi faqat VIP uchun"
            : `🌍 Endi hamma uchun${NOTIFY_ENABLED ? " (xabarnoma navbatga qo'yildi)" : ""}`
    );
    await showEditMenu(ctx, code);
});

bot.action(/^eddel:(.+)$/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    await ctx.answerCbQuery();
    const code = ctx.match[1];
    const snap = await db.collection("films").doc(code).get();
    if (!snap.exists) return ctx.reply("❌ Bu qism topilmadi.");
    const f = snap.data();
    await showOrEdit(
        ctx,
        `🗑 <b>${esc(f.title || "Drama")}</b>${f.episode ? " · " + esc(f.episode) : ""} (kod: <code>${esc(code)}</code>)\n\n` +
        `Bu qism o'chirilsinmi? ⚠️ Bu amalni qaytarib bo'lmaydi.`,
        [
            [Markup.button.callback("✅ Ha, o'chirish", `eddelok:${code}`)],
            [Markup.button.callback("⬅️ Yo'q, ortga", `edm:${code}`)],
        ]
    );
});

bot.action(/^eddelok:(.+)$/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    const code = ctx.match[1];
    const ref = db.collection("films").doc(code);
    const snap = await ref.get();
    if (!snap.exists) {
        await ctx.answerCbQuery("ℹ️ Allaqachon o'chirilgan.");
        return clearInlineButtons(ctx);
    }
    const f = snap.data();
    await ref.delete();
    invalidateDramaCache();
    removeFromNotify(code);
    await ctx.answerCbQuery("🗑 O'chirildi");
    await showOrEdit(
        ctx,
        `🗑 O'chirildi: <b>${esc(f.title || "Drama")}</b>${f.episode ? " · " + esc(f.episode) : ""} (kod: <code>${esc(code)}</code>)`,
        []
    );
});

bot.action("edcancel", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    delete userStates[ctx.from.id];
    delete editTarget[ctx.from.id];
    await ctx.answerCbQuery("Bekor qilindi.");
    await clearInlineButtons(ctx);
    await ctx.reply("❌ Tahrirlash bekor qilindi.");
});

bot.action("edclose", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    delete userStates[ctx.from.id];
    delete editTarget[ctx.from.id];
    await ctx.answerCbQuery("Yopildi.");
    await clearInlineButtons(ctx);
});

// ─────────────────────────────────────────────
// ADMIN: KENGAYTIRILGAN STATISTIKA
// ─────────────────────────────────────────────

async function showBotStats(ctx) {
    const now = Date.now();
    const TZ = 5 * 60 * 60 * 1000; // Toshkent
    const dayStart = Math.floor((now + TZ) / DAY_MS) * DAY_MS - TZ;
    const d7 = now - 7 * DAY_MS;
    const d30 = now - 30 * DAY_MS;

    const [usersSnap, filmsSnap, vipSnap, paySnap] = await Promise.all([
        db.collection("users").get(),
        db.collection("films").get(),
        db.collection("vips").get(),
        db.collection("payments").get(),
    ]);

    let total = 0, newToday = 0, new7 = 0, new30 = 0, actToday = 0, act7 = 0, muted = 0;
    usersSnap.forEach((d) => {
        const u = d.data();
        total++;
        const j = tsToMs(u.joinedAt);
        if (j >= dayStart) newToday++;
        if (j >= d7) new7++;
        if (j >= d30) new30++;
        const a = tsToMs(u.lastActiveAt);
        if (a >= dayStart) actToday++;
        if (a >= d7) act7++;
        if (u.notifyOff === true) muted++;
    });

    let episodes = 0, vipEpisodes = 0, totalViews = 0;
    const eps = [];
    const dramas = new Map();
    filmsSnap.forEach((d) => {
        const f = d.data();
        const views = Number(f.views) || 0;
        episodes++;
        if (f.vipOnly === true) vipEpisodes++;
        totalViews += views;
        eps.push({ code: d.id, title: f.title || "Nomsiz", episode: f.episode || "", views });
        const key = dramaKey(f.title);
        if (!dramas.has(key)) dramas.set(key, { title: String(f.title || "Nomsiz").trim(), views: 0, count: 0 });
        const g = dramas.get(key);
        g.views += views;
        g.count++;
    });

    let activeVip = 0;
    vipSnap.forEach((d) => {
        if (tsToMs(d.data().expiresAt) > now) activeVip++;
    });

    let revToday = 0, rev30 = 0, revAll = 0, pending = 0;
    paySnap.forEach((d) => {
        const p = d.data();
        if (p.status === "pending") pending++;
        if (p.status !== "approved") return;
        const amount = paymentAmount(p);
        const when = tsToMs(p.decidedAt) || tsToMs(p.createdAt);
        revAll += amount;
        if (when >= dayStart) revToday += amount;
        if (when >= d30) rev30 += amount;
    });

    const topEps = eps.sort((a, b) => b.views - a.views).slice(0, 10).filter((e) => e.views > 0);
    const topDramas = [...dramas.values()].sort((a, b) => b.views - a.views).slice(0, 5).filter((g) => g.views > 0);

    let text =
        `📈 <b>Bot statistikasi</b>\n` +
        `<i>${fmtDate(now)} holatiga</i>\n\n` +
        `👥 <b>Foydalanuvchilar</b>\n` +
        `• Jami: <b>${total}</b> ta\n` +
        `• Yangi: bugun <b>${newToday}</b> · 7 kunda ${new7} · 30 kunda ${new30}\n` +
        `• Faol: bugun <b>${actToday}</b> · 7 kunda ${act7}\n` +
        `• 🔕 Xabarnomani o'chirganlar: ${muted}\n\n` +
        `🎬 <b>Kontent</b>\n` +
        `• Dramalar: <b>${dramas.size}</b> ta · Qismlar: ${episodes} ta (💎 VIP: ${vipEpisodes})\n` +
        `• 👁 Jami ko'rishlar: <b>${formatSum(totalViews)}</b>\n\n` +
        `💎 <b>VIP</b>\n` +
        `• Faol VIP: <b>${activeVip}</b> ta · Kutilayotgan to'lov: ${pending}\n` +
        `• 💰 Tushum: bugun ${formatSum(revToday)} · 30 kunda ${formatSum(rev30)} · jami ${formatSum(revAll)} so'm`;

    if (topEps.length) {
        text += `\n\n🔥 <b>Eng ko'p ko'rilgan qismlar</b>`;
        topEps.forEach((e, i) => {
            text +=
                `\n${i + 1}. ${esc(shorten(e.title, 35))}${e.episode ? " · " + esc(e.episode) : ""}` +
                ` — 👁 ${formatSum(e.views)} (<code>${esc(e.code)}</code>)`;
        });
    }
    if (topDramas.length) {
        text += `\n\n🏆 <b>Eng mashhur dramalar</b>`;
        topDramas.forEach((g, i) => {
            text += `\n${i + 1}. ${esc(shorten(g.title, 40))} — 👁 ${formatSum(g.views)} (${g.count} qism)`;
        });
    }
    text += `\n\nℹ️ "Faol" ko'rsatkichi shu yangilanishdan boshlab yig'iladi.`;

    return showOrEdit(ctx, text, [[Markup.button.callback("🔄 Yangilash", "stats_refresh")]]);
}

// ─────────────────────────────────────────────
// TEXT HANDLER
// ─────────────────────────────────────────────

bot.on("text", async (ctx) => {
    const userId = ctx.from.id;
    const text = ctx.message.text.trim();
    const isAdmin = userId === ADMIN_ID;
    const state = userStates[userId];

    if (MENU_BUTTONS.includes(text)) return;

    // ── Foydalanuvchi: VIP to'lov cheki kutilmoqda ──
    if (state === "waiting_for_vip_receipt") {
        return ctx.reply(
            "❗️ Iltimos, to'lov chekini rasm (skrinshot) sifatida yuboring.",
            Markup.inlineKeyboard([[Markup.button.callback("❌ Bekor qilish", "vip_cancel")]])
        );
    }

    // ── Admin holatlari ──
    if (isAdmin && state) {
        // Yuklab olish ruxsati: foydalanuvchi qo'shish
        if (state === "waiting_for_dl_add") {
            const username = text;
            if (!username.startsWith("@")) {
                return ctx.reply("❌ Username @ bilan boshlanishi kerak. Masalan: @username");
            }
            const docId = username.replace("@", "").toLowerCase();
            if (!isValidCode(docId)) return ctx.reply("❌ Username noto'g'ri.");
            await db.collection("vipUsers").doc(docId).set({
                username: docId,
                addedAt: admin.firestore.Timestamp.now(),
            });
            await loadDownloadUsers();
            delete userStates[userId];
            return ctx.reply(`✅ @${docId} endi videoni himoyasiz (yuklab olish/forward qilish mumkin) holatda oladi.`);
        }

        // Yangi drama: kino kodi
        if (state === "waiting_for_film_code") {
            const code = text;
            if (!isValidCode(code)) {
                return ctx.reply("❌ Kod noto'g'ri (\"/\" belgisi bo'lmasligi va juda uzun bo'lmasligi kerak). Boshqa kod yuboring:");
            }
            const existing = await db.collection("films").doc(code).get();
            filmDrafts[userId] = { code, dramaId: code };
            if (existing.exists) {
                return ctx.reply(
                    `⚠️ "${code}" kodli drama allaqachon mavjud. Ustidan yozilsinmi?`,
                    Markup.inlineKeyboard([
                        [Markup.button.callback("✅ Ustidan yozish", "film_overwrite_yes")],
                        [Markup.button.callback("🔁 Boshqa kod kiritish", "film_overwrite_no")],
                        [Markup.button.callback("❌ Bekor qilish", "film_cancel")],
                    ])
                );
            }
            userStates[userId] = "waiting_for_film_title";
            return ctx.reply(
                "🎬 Endi drama nomini yuboring:",
                Markup.inlineKeyboard([[Markup.button.callback("❌ Bekor qilish", "film_cancel")]])
            );
        }

        // Yangi drama: nomi
        if (state === "waiting_for_film_title") {
            if (!filmDrafts[userId]) filmDrafts[userId] = {};
            filmDrafts[userId].title = text;
            return askFilmStep(ctx, 0);
        }

        // Qism qo'shish: namuna qism kodi
        if (state === "waiting_for_ep_base") {
            if (!isValidCode(text)) return ctx.reply("❌ Bunday kodli drama topilmadi. Qaytadan yuboring:");
            const baseDoc = await db.collection("films").doc(text).get();
            if (!baseDoc.exists) return ctx.reply("❌ Bunday kodli drama topilmadi. Qaytadan yuboring:");

            const b = baseDoc.data();
            const baseEp = typeof b.epNo === "number" ? b.epNo : parseEpNo(b.episode) || 1;
            const dramaId = b.dramaId || text;

            // Eski (guruhlanmagan) qism bo'lsa, unga drama ID va qism raqamini yozib qo'yamiz
            if (!b.dramaId || typeof b.epNo !== "number") {
                await baseDoc.ref.set({ dramaId, epNo: baseEp }, { merge: true });
            }

            const lastEpNo = await getMaxEpNo(dramaId, baseEp);
            episodeTemplates[userId] = makeTemplate({ ...b, dramaId, epNo: lastEpNo }, text);
            await ctx.reply(
                `✅ Drama topildi: ${b.title || text}\n🎞 Oxirgi qism raqami: ${lastEpNo}`
            );
            return askNextEpisode(ctx);
        }

        // Qism qo'shish: yangi kod
        if (state === "waiting_for_ep_code") {
            return acceptEpisodeCode(ctx, text);
        }

        // Qism qo'shish: qism raqami
        if (state === "waiting_for_ep_number") {
            const label = normalizeEpisode(text);
            const epNo = parseEpNo(label);
            if (epNo === null) {
                return ctx.reply("❌ Qism raqami bo'lishi kerak (masalan: 5 yoki 5-qism). Qaytadan yuboring:");
            }
            return acceptEpisodeNumber(ctx, epNo, label);
        }

        // Yangi drama: ixtiyoriy maydonlar, auditoriya, video
        if (state.startsWith("waiting_for_film_")) {
            const key = state.replace("waiting_for_film_", "");
            if (key === "video") {
                return ctx.reply("❗️ Iltimos, video fayl sifatida yuboring (matn emas).");
            }
            if (key === "audience") {
                return ctx.reply("❗️ Iltimos, yuqoridagi tugmalardan birini tanlang: VIP yoki Hamma uchun.");
            }
            const idx = FILM_OPTIONAL_STEPS.findIndex((s) => s.key === key);
            if (idx !== -1) {
                if (!filmDrafts[userId]) filmDrafts[userId] = {};
                filmDrafts[userId][key] = key === "episode" ? normalizeEpisode(text) : text;
                return askFilmStep(ctx, idx + 1);
            }
        }

        // Yangi majburiy kanal qo'shish
        if (state === "waiting_for_channel_add") {
            const username = text;
            if (!username.startsWith("@")) {
                return ctx.reply("❌ Username @ bilan boshlanishi kerak. Masalan: @kanal_nomi");
            }
            try {
                const chat = await bot.telegram.getChat(username);
                const me = await bot.telegram.getMe();
                const member = await bot.telegram.getChatMember(username, me.id);
                if (!["administrator", "creator"].includes(member.status)) {
                    return ctx.reply("❌ Bot bu kanalda admin emas. Avval botni kanalga admin qilib qo'shing, so'ng qaytadan urinib ko'ring.");
                }
                const docId = username.replace("@", "");
                await db.collection("channels").doc(docId).set({
                    channelId: username,
                    name: chat.title || username,
                    url: `https://t.me/${docId}`,
                });
                await loadChannels();
                delete userStates[userId];
                return ctx.reply(`✅ Kanal qo'shildi: ${chat.title || username}`);
            } catch (err) {
                console.error("Kanal qo'shishda xatolik:", err.message);
                return ctx.reply("❌ Kanal topilmadi yoki botga ruxsat yo'q. Username to'g'riligini va bot kanalga qo'shilganini tekshiring.");
            }
        }

        // Matnli reklama
        if (state === "waiting_for_adv_media") {
            advData[userId] = { type: "text", text };
            userStates[userId] = "waiting_for_adv_confirm";

            return ctx.reply(
                `📝 Matn qabul qilindi!\n\n"${text}"\n\n❓ Ushbu reklamani barcha foydalanuvchilarga yuborishni tasdiqlaysizmi?`,
                Markup.inlineKeyboard([
                    [Markup.button.callback("✅ Ha, yuborish", "confirm_adv")],
                    [Markup.button.callback("❌ Bekor qilish", "cancel_adv_text")],
                ])
            );
        }

        // VIP boshqaruvi: foydalanuvchini topish (berish / olib tashlash)
        if (state === "waiting_for_vip_target_grant" || state === "waiting_for_vip_target_revoke") {
            const target = await resolveUser(text);
            if (!target) {
                return ctx.reply("❌ Foydalanuvchi topilmadi. ID raqamini yoki @username'ni qayta yuboring:");
            }

            if (state === "waiting_for_vip_target_revoke") {
                const vipRef = db.collection("vips").doc(String(target.userId));
                if (!(await vipRef.get()).exists) {
                    delete userStates[userId];
                    return ctx.reply(`ℹ️ ${displayName(target)} VIP emas.`);
                }
                await vipRef.delete();
                delete userStates[userId];
                return ctx.reply(`✅ ${displayName(target)} dan VIP olib tashlandi.`);
            }

            vipAdminTarget[userId] = target;
            userStates[userId] = "waiting_for_vip_days";
            return ctx.reply(
                `👤 ${displayName(target)}${target.username ? " (@" + target.username + ")" : ""}\n🆔 ${target.userId}\n\nNecha kunlik VIP berilsin? Tugmani bosing yoki kun sonini yozing:`,
                Markup.inlineKeyboard([
                    [
                        Markup.button.callback("30 kun", "vipg:30"),
                        Markup.button.callback("90 kun", "vipg:90"),
                        Markup.button.callback("365 kun", "vipg:365"),
                    ],
                ])
            );
        }

        // VIP boshqaruvi: kun soni yozildi
        if (state === "waiting_for_vip_days") {
            if (!/^\d{1,4}$/.test(text) || parseInt(text, 10) < 1) {
                return ctx.reply("❌ Kun sonini raqam bilan yozing (masalan: 45) yoki tugmani bosing.");
            }
            return askVipPayType(ctx, parseInt(text, 10));
        }

        // VIP boshqaruvi: pullik/tekin tanlovi kutilmoqda
        if (state === "waiting_for_vip_paytype") {
            return ctx.reply("❗️ Iltimos, yuqoridagi tugmalardan birini tanlang: pullik, boshqa summa yoki tekin.");
        }

        // VIP boshqaruvi: boshqa summa yozildi
        if (state === "waiting_for_vip_amount") {
            if (!/^[\d\s]{1,12}$/.test(text)) {
                return ctx.reply("❌ Summani faqat raqam bilan yozing (masalan: 25000). Tekin uchun 0.");
            }
            try {
                return await completeManualGrant(ctx, parseAmount(text));
            } catch (err) {
                console.error("completeManualGrant xatolik:", err);
                return ctx.reply("❌ Xatolik yuz berdi. Qayta urinib ko'ring.");
            }
        }

        // Qismni tahrirlash: kod kutilmoqda
        if (state === "waiting_for_edit_code") {
            if (!isValidCode(text) || !(await db.collection("films").doc(text).get()).exists) {
                return ctx.reply("❌ Bunday kodli qism topilmadi. Kodni qayta yuboring:");
            }
            delete userStates[userId];
            return showEditMenu(ctx, text);
        }

        // Qismni tahrirlash: yangi qiymat
        if (state === "waiting_for_edit_value") {
            return applyEditValue(ctx, text);
        }
        if (state === "waiting_for_edit_video") {
            return ctx.reply("❗️ Iltimos, yangi videoni video fayl sifatida yuboring.");
        }
    }

    // ── Oddiy foydalanuvchi: obuna tekshiruvi ──
    const subscribed = await checkSubscription(ctx);
    if (!subscribed) return;

    // ── Kino kodi bilan qidiruv ──
    if (await sendEpisode(ctx, text)) return;

    // ── Nomi bo'yicha qidiruv ──
    const groups = await loadDramaGroups();
    const matches = searchDramas(groups, text);
    if (matches.length > 0) return showSearchResults(ctx, groups, matches, text);

    // ── Topilmasa so'rov yuborish ──
    const requested = text.slice(0, 200);
    await db.collection("requests").add({
        title: requested,
        requestedAt: admin.firestore.Timestamp.now(),
    });
    await ctx.reply("😔 Bunday kod yoki nomdagi drama topilmadi.\n\n📌 So'rovingiz adminlarga yuborildi, tez orada qo'shishga harakat qilamiz!");
    try {
        await bot.telegram.sendMessage(
            ADMIN_CHAT_ID,
            `📌 <b>Yangi drama so'rovi!</b>\n\n🎬 ${esc(requested)}`,
            { parse_mode: "HTML" }
        );
    } catch (err) {
        console.error("Admin chatga yuborishda xatolik:", err);
    }
});

// ─────────────────────────────────────────────
// REKLAMA TASDIQLASH / BEKOR QILISH
// ─────────────────────────────────────────────

bot.action("confirm_adv", async (ctx) => {
    const userId = ctx.from.id;

    if (userId !== ADMIN_ID || userStates[userId] !== "waiting_for_adv_confirm") {
        return ctx.answerCbQuery("❌ Ruxsat yo'q yoki amal muddati o'tgan.");
    }

    await ctx.answerCbQuery("⏳ Reklama yuborilmoqda...");
    await ctx.reply("⏳ Reklama yuborilmoqda, iltimos kuting...");

    const adv = advData[userId];
    delete userStates[userId];
    delete advData[userId];

    await sendAdvToAll(ctx, adv);
});

bot.action("cancel_adv_text", async (ctx) => {
    const userId = ctx.from.id;
    if (userId !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");

    await ctx.answerCbQuery("Bekor qilindi.");
    await ctx.reply("❌ Reklama yuborish bekor qilindi.");
    delete userStates[userId];
    delete advData[userId];
});

// ─────────────────────────────────────────────
// XATOLARNI USHLASH
// ─────────────────────────────────────────────

bot.catch(async (err, ctx) => {
    console.error("BOT ERROR:", err);
    if (err.response && err.response.error_code === 403) {
        const id = ctx && ctx.from && ctx.from.id;
        if (id) {
            await db.collection("users").doc(id.toString()).delete().catch(() => { });
        }
    }
});

// ─────────────────────────────────────────────
// ISHGA TUSHIRISH
// ─────────────────────────────────────────────

(async () => {
    try {
        await seedChannelsIfEmpty();
        await loadChannels();
        await loadDownloadUsers();
        await backfillManualVipPayments().catch((e) => console.error("backfillManualVipPayments:", e.message));
    } catch (err) {
        console.error("Ishga tushirishda xatolik:", err);
        process.exit(1);
    }

    // VIP eslatmalari: ishga tushgandan 30 soniya keyin, so'ng har 6 soatda
    const runReminders = () => vipReminderJob().catch((e) => console.error("vipReminderJob:", e.message));
    setTimeout(runReminders, 30 * 1000);
    setInterval(runReminders, 6 * 60 * 60 * 1000);

    process.once("SIGINT", () => { try { bot.stop("SIGINT"); } catch (e) { } });
    process.once("SIGTERM", () => { try { bot.stop("SIGTERM"); } catch (e) { } });

    console.log("🚀 SeoulFlix Bot ishga tushmoqda...");
    await bot.launch();
})();