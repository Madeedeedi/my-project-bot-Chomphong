require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  ChannelType,
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

// ============ Mute ============
async function ensureMuteRole(guild) {
  let role = guild.roles.cache.find((r) => r.name === "Anti-Spam Mute");
  if (!role) {
    try {
      role = await guild.roles.create({
        name: "Anti-Spam Mute",
        permissions: [],
      });
    } catch {
      return null;
    }
  }
  return role;
}

async function muteUser(member, guild) {
  const timeoutSeconds = config.muteDuration / 1000;
  const me = guild.members.me;

  if (me.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    await member.timeout(config.muteDuration, "กันแสปม");
    return timeoutSeconds;
  }

  const muteRole = await ensureMuteRole(guild);
  if (!muteRole)
    throw new Error("ไม่สามารถสร้าง role mute ได้ (ต้องการ Manage Roles)");
  await member.roles.add(muteRole);
  setTimeout(async () => {
    await member.roles.remove(muteRole).catch(() => {});
  }, config.muteDuration);
  return timeoutSeconds;
}

// ลบข้อความแสปมของผู้ใช้เฉพาะในช่องธรรมดา
// ข้าม thread / โพสต์ฟอรั่ม / คอมเมนต์ใต้โพส (โซน "โพส") ไม่ลบ
async function purgeUserMessages(guild, userId) {
  let deleted = 0;
  const oldestAllowed = Date.now() - config.purgeWindowHours * 60 * 60 * 1000;
  const allowedTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

  for (const channel of guild.channels.cache.values()) {
    if (!allowedTypes.includes(channel.type)) continue;
    if (!channel.isTextBased()) continue;
    if (!channel.viewable) continue;
    if (!channel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.ManageMessages)) continue;
    try {
      const messages = await channel.messages.fetch({ limit: config.purgePerChannel });
      const toDelete = messages.filter(
        (m) =>
          m.author.id === userId &&
          m.createdTimestamp >= oldestAllowed &&
          m.deletable
      );
      if (toDelete.size > 0) {
        await channel.bulkDelete(toDelete, true);
        deleted += toDelete.size;
      }
    } catch {}
  }
  return deleted;
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
    // แบนถาวร (ไม่ใช้ deleteMessageSeconds เพราะต้องเลือกช่องลบเอง) + ลบข้อความแสปมเฉพาะช่องธรรมดา
    const deleted = await purgeUserMessages(message.guild, message.author.id);
    await message.member.ban({
      reason: "พิมพ์ข้อความใน channel ต้องห้าม",
    });
    console.log(`🔨 แบน: ${message.author.tag}, ลบข้อความ ${deleted} ชิ้น (channel ต้องห้าม)`);
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

  try {
    // ลบเฉพาะข้อความแสปมชิ้นนี้
    await message.delete();
  } catch {}

  try {
    // ลบข้อความแสปมในช่องธรรมดา (ข้ามโซนโพส) แล้วค่อย mute
    const deleted = await purgeUserMessages(message.guild, message.author.id);
    const timeoutSeconds = await muteUser(message.member, message.guild);
    await message.channel
      .send(`⛔ <@${message.author.id}> ถูก mute ${timeoutSeconds / 60} นาที (${reason})${deleted ? ` ลบข้อความแสปม ${deleted} ชิ้น` : ""}`)
      .catch(() => {});
  } catch (err) {
    console.error("Anti-spam error:", err);
    await message.channel
      .send(`⚠️ ตรวจพบการแสปมจาก <@${message.author.id}> (${reason})`)
      .catch(() => {});
  }
}

client.login(process.env.DISCORD_TOKEN);