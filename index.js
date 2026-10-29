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

// Klaviatura tugmalari (bir joyda, xato qilmaslik uchun)
const BTN = {
    LIST: "📜 Kino roʻyxati",
    SEARCH: "🔍 Kino izlash",
    VIP: "💎 VIP",
    ADV: "📢 Reklama yuborish",
    COUNT: "👥 Obunachilar soni",
    CHANNELS: "📡 Majburiy kanallar",
    ADD_DRAMA: "🎬 Drama qo'shish",
    ADD_EP: "➕ Qism qo'shish",
    DOWNLOAD: "⭐ Yuklab olish ruxsati",
    VIP_ADMIN: "💎 VIP boshqaruvi",
};
const MENU_BUTTONS = Object.values(BTN);

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

function tsToMs(ts) {
    return ts && typeof ts.toMillis === "function" ? ts.toMillis() : 0;
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

async function grantVipDays(target, days, grantedBy) {
    const ref = db.collection("vips").doc(String(target.userId));
    return db.runTransaction(async (t) => {
        const snap = await t.get(ref);
        const expiresMs = calcExpiry(snap, days);
        t.set(ref, vipDocData(target, expiresMs, grantedBy, !snap.exists), { merge: true });
        return expiresMs;
    });
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
        const d = await db.collection("users").doc(t).get();
        return d.exists ? d.data() : null;
    }
    const uname = t.replace(/^@/, "").toLowerCase();
    if (!uname) return null;
    const snap = await db.collection("users").get();
    const found = snap.docs.find((d) => String(d.data().username || "").toLowerCase() === uname);
    return found ? found.data() : null;
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
    return toOpen.map((d) => ({ code: d.id, episode: d.data().episode || "" }));
}

async function openAllEpisodes(dramaId) {
    const snap = await db.collection("films").where("dramaId", "==", dramaId).get();
    const closed = snap.docs.filter((d) => d.data().vipOnly === true);
    if (closed.length === 0) return 0;
    const batch = db.batch();
    closed.forEach((d) => batch.update(d.ref, { vipOnly: false, openedAt: admin.firestore.Timestamp.now() }));
    await batch.commit();
    return closed.length;
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

    const buttons = [[Markup.button.callback("➕ Keyingi qism", "ep_next")]];
    if (filmData.vipOnly) buttons.push([Markup.button.callback("🔓 Dramani to'liq hammaga ochish", "ep_open_all")]);
    buttons.push([Markup.button.callback("✅ Tugatish", "ep_finish")]);

    return ctx.reply(msg, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
}

// ─────────────────────────────────────────────
// OBUNA TEKSHIRISH
// ─────────────────────────────────────────────

async function checkSubscription(ctx) {
    const userId = ctx.from.id;
    if (VIP_SKIPS_SUBSCRIPTION && (await hasVipAccess(userId))) return true;

    for (const ch of CHECK_CHANNELS) {
        try {
            const member = await bot.telegram.getChatMember(ch, userId);
            if (["left", "kicked"].includes(member.status)) {
                const buttons = SHOW_CHANNELS.map((c) => [Markup.button.url(c.name, c.url)]);
                buttons.push([Markup.button.callback("✅ Tekshirish", "check_membership")]);
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

bot.use(async (ctx, next) => {
    const text = ctx.message && ctx.message.text;
    if (text && ctx.from && ctx.from.id !== ADMIN_ID && MENU_BUTTONS.includes(text.trim())) {
        delete userStates[ctx.from.id];
    }
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

    const userRef = db.collection("users").doc(userId.toString());
    const doc = await userRef.get();

    if (!doc.exists) {
        await userRef.set({
            userId,
            firstName: ctx.from.first_name || "",
            lastName: ctx.from.last_name || "",
            username: ctx.from.username || "",
            joinedAt: admin.firestore.Timestamp.now(),
        });
    }

    const keyboard = [[BTN.LIST, BTN.SEARCH], [BTN.VIP]];
    if (userId === ADMIN_ID) {
        keyboard.push([BTN.ADV, BTN.COUNT]);
        keyboard.push([BTN.CHANNELS, BTN.ADD_DRAMA]);
        keyboard.push([BTN.DOWNLOAD, BTN.ADD_EP]);
        keyboard.push([BTN.VIP_ADMIN]);
    }

    try {
        await ctx.reply(
            "🎬 SeoulFlix botiga xush kelibsiz!\n\nQuyidagi tugmalar orqali istagan dramangizni topishingiz yoki drama kodini yuborishingiz mumkin 👇",
            Markup.keyboard(keyboard).resize()
        );

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

bot.action("check_membership", async (ctx) => {
    const userId = ctx.from.id;
    const notSubscribed = [];

    for (const ch of CHECK_CHANNELS) {
        try {
            const res = await bot.telegram.getChatMember(ch, userId);
            if (["left", "kicked"].includes(res.status)) notSubscribed.push(ch);
        } catch {
            notSubscribed.push(ch);
        }
    }

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
    await ctx.reply(
        "💎 VIP boshqaruvi",
        Markup.inlineKeyboard([
            [Markup.button.callback("📊 Statistika", "vipadm_stats")],
            [Markup.button.callback("📋 Faol VIP'lar", "vipadm_list")],
            [Markup.button.callback("➕ VIP berish", "vipadm_grant")],
            [Markup.button.callback("🗑 VIP olib tashlash", "vipadm_revoke")],
        ])
    );
});

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
    let pending = 0, approved = 0, rejected = 0, revenue = 0;
    paySnap.forEach((d) => {
        const p = d.data();
        if (p.status === "pending") pending++;
        else if (p.status === "approved") {
            approved++;
            revenue += Number(p.amount) || 0;
        } else if (p.status === "rejected") rejected++;
    });

    await ctx.reply(
        `📊 <b>VIP statistikasi</b>\n\n` +
        `💎 Faol VIP: <b>${active}</b> ta\n` +
        `👥 Jami VIP bo'lganlar: ${vipSnap.size} ta\n\n` +
        `⏳ Kutilayotgan to'lovlar: ${pending} ta\n` +
        `✅ Tasdiqlangan: ${approved} ta\n` +
        `❌ Rad etilgan: ${rejected} ta\n\n` +
        `💰 To'lovlar orqali tushum: <b>${formatSum(revenue)} so'm</b>`,
        { parse_mode: "HTML" }
    );
});

bot.action("vipadm_list", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    await ctx.answerCbQuery();

    const now = Date.now();
    const snap = await db.collection("vips").get();
    const rows = snap.docs
        .map((d) => d.data())
        .map((v) => ({ ...v, expiresMs: tsToMs(v.expiresAt) }))
        .filter((v) => v.expiresMs > now)
        .sort((a, b) => a.expiresMs - b.expiresMs);

    if (rows.length === 0) return ctx.reply("📭 Hozircha faol VIP foydalanuvchilar yo'q.");

    const LIMIT = 40;
    let msg = `📋 <b>Faol VIP'lar</b> (${rows.length} ta)\n`;
    rows.slice(0, LIMIT).forEach((v, i) => {
        msg += `\n${i + 1}. ${esc(displayName(v))}${v.username ? " (@" + esc(v.username) + ")" : ""} — ${fmtDate(v.expiresMs)} gacha`;
    });
    if (rows.length > LIMIT) msg += `\n\n…va yana ${rows.length - LIMIT} ta`;
    await ctx.reply(msg, { parse_mode: "HTML" });
});

bot.action("vipadm_grant", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    await ctx.answerCbQuery();
    userStates[ctx.from.id] = "waiting_for_vip_target_grant";
    delete vipAdminTarget[ctx.from.id];
    await ctx.reply("➕ VIP beriladigan foydalanuvchining @username yoki ID raqamini yuboring (u botdan foydalangan bo'lishi kerak):");
});

bot.action("vipadm_revoke", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
    await ctx.answerCbQuery();
    userStates[ctx.from.id] = "waiting_for_vip_target_revoke";
    await ctx.reply("🗑 VIP olib tashlanadigan foydalanuvchining @username yoki ID raqamini yuboring:");
});

async function completeManualGrant(ctx, days) {
    const adminId = ctx.from.id;
    const target = vipAdminTarget[adminId];
    if (!target) {
        delete userStates[adminId];
        return ctx.reply("❌ Foydalanuvchi tanlanmagan. «💎 VIP boshqaruvi» orqali qaytadan boshlang.");
    }

    const expiresMs = await grantVipDays(target, days, "admin");
    delete userStates[adminId];
    delete vipAdminTarget[adminId];

    await ctx.reply(`✅ ${displayName(target)} ga ${days} kunlik VIP berildi. Muddat: ${fmtDate(expiresMs)} gacha.`);
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
    const days = parseInt(ctx.match[1], 10);
    try {
        await completeManualGrant(ctx, days);
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

bot.hears(BTN.COUNT, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply("❌ Siz admin emassiz!");
    const snapshot = await db.collection("users").get();
    await ctx.reply(`📊 Botda jami *${snapshot.size}* ta foydalanuvchi mavjud.`, {
        parse_mode: "Markdown",
    });
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
        const n = await openAllEpisodes(tpl.dramaId);
        await ctx.reply(n > 0 ? `🔓 ${n} ta qism hammaga ochildi.` : "ℹ️ VIP uchun yopiq qism qolmagan.");
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

bot.hears(BTN.LIST, async (ctx) => {
    const subscribed = await checkSubscription(ctx);
    if (!subscribed) return;

    const snapshot = await db.collection("films").get();
    if (snapshot.empty) return ctx.reply("❌ Hozircha bazaga hech qanday drama qo'shilmagan.");

    // Kino kodi bo'yicha raqamli tartib (1, 2, 10)
    const films = snapshot.docs
        .map((doc) => {
            const d = doc.data();
            return {
                code: doc.id,
                title: d.title || "Nomsiz",
                episode: d.episode || "",
                vipOnly: d.vipOnly === true,
            };
        })
        .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

    let header = "🎬 <b>SeoulFlix Drama Ro'yxati</b>";
    if (films.some((f) => f.vipOnly)) header += "\n💎 — hozircha faqat VIP uchun";

    const chunks = [];
    let current = header + "\n";
    for (const f of films) {
        const line =
            `🎬 <b>${esc(f.title)}</b>${f.episode ? " · " + esc(f.episode) : ""}${f.vipOnly ? " 💎" : ""}` +
            ` — Kod: <code>${esc(f.code)}</code>`;
        // Telegram xabar limiti 4096 belgi
        if (current.length + line.length + 1 > 3800) {
            chunks.push(current);
            current = line;
        } else {
            current += "\n" + line;
        }
    }
    chunks.push(current);

    for (const chunk of chunks) {
        await ctx.reply(chunk, { parse_mode: "HTML" });
    }
});

bot.hears(BTN.SEARCH, async (ctx) => {
    const subscribed = await checkSubscription(ctx);
    if (!subscribed) return;
    ctx.reply("🔎 Drama kodini yuboring yoki nomini yozing 👇");
});

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
                return ctx.reply("❌ Foydalanuvchi topilmadi. U botdan foydalangan bo'lishi kerak. @username yoki ID ni qayta yuboring:");
            }

            if (state === "waiting_for_vip_target_revoke") {
                await db.collection("vips").doc(String(target.userId)).delete();
                delete userStates[userId];
                return ctx.reply(`✅ ${displayName(target)} dan VIP olib tashlandi.`);
            }

            vipAdminTarget[userId] = target;
            userStates[userId] = "waiting_for_vip_days";
            return ctx.reply(
                `👤 ${displayName(target)}${target.username ? " (@" + target.username + ")" : ""}\n\nNecha kunlik VIP berilsin? Tugmani bosing yoki kun sonini yozing:`,
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
            try {
                return await completeManualGrant(ctx, parseInt(text, 10));
            } catch (err) {
                console.error("completeManualGrant xatolik:", err);
                return ctx.reply("❌ Xatolik yuz berdi. Qayta urinib ko'ring.");
            }
        }
    }

    // ── Oddiy foydalanuvchi: obuna tekshiruvi ──
    const subscribed = await checkSubscription(ctx);
    if (!subscribed) return;

    // ── Kino kodi bilan qidiruv ──
    const filmDoc = isValidCode(text) ? await db.collection("films").doc(text).get() : null;
    if (filmDoc && filmDoc.exists) {
        const film = filmDoc.data();

        // VIP uchun yopiq qism
        if (film.vipOnly === true && !(await hasVipAccess(userId))) {
            return ctx.reply(
                `🔒 <b>${esc(film.title || "Drama")}</b>${film.episode ? " · " + esc(film.episode) : ""}\n\n` +
                `Bu qism hozircha <b>faqat VIP</b> foydalanuvchilar uchun.\n` +
                `⏳ Oddiy foydalanuvchilar uchun u keyinroq ochiladi.\n\n` +
                `💎 VIP bilan yangi qismlarni ${VIP_AHEAD} qism oldin va reklamasiz ko'ring!`,
                {
                    parse_mode: "HTML",
                    ...Markup.inlineKeyboard([[Markup.button.callback("💎 VIP haqida", "vip_info")]]),
                }
            );
        }

        try {
            await incrementViewCount(text);
            const updatedViews = (film.views || 0) + 1;

            const requesterUsername = (ctx.from.username || "").toLowerCase();
            const canDownload = DOWNLOAD_USERNAMES.has(requesterUsername);

            await ctx.replyWithVideo(film.video_link, {
                caption: buildCaption(film, updatedViews),
                parse_mode: "HTML",
                protect_content: !canDownload,
            });
        } catch (err) {
            console.error("Video yuborishda xatolik:", err.message);
            await ctx.reply("❌ Video yuborishda xatolik yuz berdi.");
        }
        return;
    }

    // ── Topilmasa so'rov yuborish ──
    const requested = text.slice(0, 200);
    await db.collection("requests").add({
        title: requested,
        requestedAt: admin.firestore.Timestamp.now(),
    });
    await ctx.reply("⏳ Ushbu drama hozircha bazada mavjud emas.\n\n📌 So'rovingiz adminlarga yuborildi!");
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