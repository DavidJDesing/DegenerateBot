import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
} from "discord.js";
import { DB } from "./db.js";
import {
  statsCommand,
  handleStats,
  handleStatsPeriodButton,
} from "./commands/stats.js";

// ---------------- ENV ----------------

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId) {
  throw new Error("Missing DISCORD_TOKEN or CLIENT_ID in .env");
}

// ---------------- ERROR VISIBILITY ----------------

process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

// ---------------- CLIENT ----------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});

// ---------------- COMMAND REGISTRATION ----------------

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(token);
  const body = [statsCommand.toJSON()];

  if (guildId) {
    await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body }
    );
    console.log(`Slash commands registered (GUILD) for ${guildId}`);
  } else {
    await rest.put(
      Routes.applicationCommands(clientId),
      { body }
    );
    console.log(
      "Slash commands registered (GLOBAL) — changes may take up to 1 hour"
    );
  }
}

// ---------------- MESSAGE TRACKING ----------------

client.on("messageCreate", async (message) => {
  try {
    if (!message.guildId) return;
    if (message.author?.bot) return;

    const day = DB.utcDayString();

    await DB.incUserMsg({
      guild_id: message.guildId,
      user_id: message.author.id,
      day,
    });

    await DB.incChannelMsg({
      guild_id: message.guildId,
      channel_id: message.channelId,
      day,
    });
  } catch (err) {
    console.error("messageCreate error:", err);
  }
});

// ---------------- VOICE TRACKING ----------------

client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    const guildId = newState.guild.id;
    const userId = newState.id;

    const member = newState.member ?? oldState.member;
    if (member?.user?.bot) return;

    const oldChannelId = oldState.channelId;
    const newChannelId = newState.channelId;

    // Join
    if (!oldChannelId && newChannelId) {
      await DB.upsertSession({
        guild_id: guildId,
        user_id: userId,
        channel_id: newChannelId,
        started_at_ms: Date.now(),
      });
      return;
    }

    // Leave
    if (oldChannelId && !newChannelId) {
      await closeSession(guildId, userId);
      return;
    }

    // Move
    if (oldChannelId && newChannelId && oldChannelId !== newChannelId) {
      await closeSession(guildId, userId);
      await DB.upsertSession({
        guild_id: guildId,
        user_id: userId,
        channel_id: newChannelId,
        started_at_ms: Date.now(),
      });
    }
  } catch (err) {
    console.error("voiceStateUpdate error:", err);
  }
});

async function closeSession(guildId, userId) {
  const sess = await DB.getSession(guildId, userId);
  if (!sess) return;

  const now = Date.now();
  const seconds = Math.max(
    0,
    Math.floor((now - sess.started_at_ms) / 1000)
  );

  await DB.deleteSession(guildId, userId);
  if (seconds <= 0) return;

  const day = DB.utcDayString(now);

  await DB.addUserVoice({
    guild_id: guildId,
    user_id: userId,
    day,
    voice_seconds: seconds,
  });

  await DB.addChannelVoice({
    guild_id: guildId,
    channel_id: sess.channel_id,
    day,
    voice_seconds: seconds,
  });
}

// ---------------- READY ----------------

client.on("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// ---------------- INTERACTIONS ----------------

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "stats") {
        await handleStats(interaction);
        return;
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith("stats:period:")) {
        await handleStatsPeriodButton(interaction);
        return;
      }
    }
  } catch (err) {
    console.error("interactionCreate error:", err);
    if (interaction.isRepliable()) {
      await interaction
        .reply({ content: "An error occurred.", ephemeral: true })
        .catch(() => {});
    }
  }
});

// ---------------- STARTUP ----------------

await DB.init();
await registerCommands();
await client.login(token);
