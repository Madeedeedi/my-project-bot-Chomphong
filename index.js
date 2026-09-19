require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
} = require("discord.js");
const config = require("./config");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ============ State ============
const messageCounts = new Map();
const lastMessages = new Map();

function keyFor(guildId, userId) {
  return `${guildId}:${userId}`;
}

function resetUser(guildId, userId) {
  messageCounts.delete(keyFor(guildId, userId));
}

function isStaff(member) {
  if (!member) return false;
  if (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild)
  )
    return true;
  if (config.staffRoleIds.length) {
    return member.roles.cache.some((r) => config.staffRoleIds.includes(r.id));
  }
  return false;
}

// ============ Events ============
client.once("ready", () => {
  console.log(`✅ Bot กันแสปมพร้อมใช้งาน: ${client.user.tag}`);
  console.log(`🌍 เซิร์ฟเวอร์: ${client.guilds.cache.map((g) => g.name).join(", ")}`);
  client.guilds.cache.forEach((g) => {
    const channels = g.channels.cache
      .filter((c) => c.type === 0)
      .map((c) => `${c.name} (#${c.id})`);
    console.log(`📂 ${g.name}: ${channels.join(", ")}`);
  });
  client.user.setActivity("กันแสปม", { type: 3 });
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const member =
    message.member ??
    (await message.guild.members
      .fetch(message.author.id)
      .catch(() => null));
  if (!member) return;

  // ห้ามพิมพ์ในช่อง bannedChannels → ลบ + แบนถาวร
  if (config.bannedChannels.includes(message.channel.id)) {
    return handleBannedChannel(message);
  }

  if (isStaff(member)) return;

  const key = keyFor(message.guild.id, message.author.id);
  const now = Date.now();

  // ข้อความซ้ำ
  const prev = lastMessages.get(key);
  if (prev && prev.content === message.content && now - prev.timestamp < config.duplicateWindow) {
    handleSpam(message, "ส่งข้อความซ้ำกัน");
    return;
  }
  lastMessages.set(key, { content: message.content, timestamp: now });

  // ข้อความยาวเกิน
  if (message.content.length > config.maxMessageLength) {
    handleSpam(message, "ข้อความยาวเกินกำหนด");
    return;
  }

  // จำนวนข้อความถี่เกิน
  const entry = messageCounts.get(key) || { count: 0, first: now };
  if (now - entry.first < config.rateWindow) {
    entry.count++;
    if (entry.count >= config.maxMessages) {
      handleSpam(message, "ส่งข้อความถี่เกินไป");
      return;
    }
    if (!entry.timer) {
      entry.timer = setTimeout(
        () => resetUser(message.guild.id, message.author.id),
        config.rateWindow + 1000
      );
    }
    messageCounts.set(key, entry);
  } else {
    clearTimeout(entry.timer);
    messageCounts.set(key, {
      count: 1,
      first: now,
      timer: setTimeout(
        () => resetUser(message.guild.id, message.author.id),
        config.rateWindow + 1000
      ),
    });
  }
});

// ============ Handlers ============
async function handleBannedChannel(message) {
  try {
    await message.delete();
  } catch {}
  try {
    // แบนโดยไม่ลบข้อความเก่า (ไม่ระบุ deleteMessageSeconds)
    await message.member.ban({
      reason: "พิมพ์ข้อความใน channel ต้องห้าม",
    });
    console.log(`🔨 แบน: ${message.author.tag} (channel ต้องห้าม)`);
  } catch (err) {
    console.error("Ban error:", err);
    await message.channel
      .send(`⚠️ ต้องการแบน <@${message.author.id}> แต่บอทไม่มีสิทธิ์ (Permissions: BanMembers)`)
      .catch(() => {});
  }
}

async function handleSpam(message, reason) {
  const key = keyFor(message.guild.id, message.author.id);
  resetUser(message.guild.id, message.author.id);
  lastMessages.delete(key);

  // ลบเฉพาะข้อความแสปมชิ้นนี้ ไม่แตะข้อความเก่า
  try {
    await message.delete();
  } catch {}

  try {
    // แบนถาวรทันที โดยไม่ระบุ deleteMessageSeconds
    // → ข้อความปกติที่ผู้ใช้เคยเขียนไว้ก่อนหน้ายังคงอยู่
    await message.member.ban({ reason });
    console.log(`🔨 แบนถาวร: ${message.author.tag} (${reason})`);
    await message.channel
      .send(`⛔ <@${message.author.id}> ถูกแบนถาวรทันที (${reason})`)
      .catch(() => {});
  } catch (err) {
    console.error("Anti-spam error:", err);
    await message.channel
      .send(`⚠️ ตรวจพบการแสปมจาก <@${message.author.id}> (${reason}) แต่บอทไม่มีสิทธิ์แบน (ต้องการ BanMembers)`)
      .catch(() => {});
  }
}

client.login(process.env.DISCORD_TOKEN);