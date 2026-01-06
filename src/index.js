// index.js
import "dotenv/config";
import { banCommand, handleBan } from "./ban.js";
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  ContextMenuCommandBuilder,
  ApplicationCommandType,
} from "discord.js";

import { DB } from "./db.js";
import {
  statsCommand,
  handleStats,
  handleStatsPeriodButton,
} from "./stats.js";

// QUOTE RENDERER (your existing one)
import { renderQuoteImage } from "./render_quote.js";

// ---------------- ENV ----------------

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId) {
  throw new Error("Missing DISCORD_TOKEN or CLIENT_ID");
}

// ---------------- ERROR VISIBILITY ----------------

process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

// ---------------- CLIENT ----------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent, // REQUIRED for quote rendering
  ],
  partials: [Partials.Channel],
});

// ---------------- COMMAND DEFINITIONS ----------------

// Message context menu: Quote
const quoteCommand = new ContextMenuCommandBuilder()
  .setName("Quote")
  .setType(ApplicationCommandType.Message);

// ---------------- COMMAND REGISTRATION ----------------

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(token);

  const commands = [
    statsCommand.toJSON(),
    quoteCommand.toJSON(),
    banCommand.toJSON(),
  ];

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: commands,
    });
    console.log("Registered GUILD commands");
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log("Registered GLOBAL commands");
  }
}

// ---------------- MESSAGE TRACKING (STATS) ----------------

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

// ---------------- VOICE TRACKING (STATS) ----------------

client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    const guildId = newState.guild.id;
    const userId = newState.id;

    const member = newState.member ?? oldState.member;
    if (member?.user?.bot) return;

    const oldChannelId = oldState.channelId;
    const newChannelId = newState.channelId;

    if (!oldChannelId && newChannelId) {
      await DB.upsertSession({
        guild_id: guildId,
        user_id: userId,
        channel_id: newChannelId,
        started_at_ms: Date.now(),
      });
      return;
    }

    if (oldChannelId && !newChannelId) {
      await closeSession(guildId, userId);
      return;
    }

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

  const seconds = Math.floor((Date.now() - sess.started_at_ms) / 1000);
  await DB.deleteSession(guildId, userId);

  if (seconds <= 0) return;

  const day = DB.utcDayString();

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

// ---------------- INTERACTIONS ----------------

client.on("interactionCreate", async (interaction) => {
  try {
    // Slash commands
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "stats") {
        await handleStats(interaction);
        return;
      }

      if (interaction.commandName === "ban") {
        await handleBan(interaction);
        return;
      }
    }

    // stats buttons
    if (interaction.isButton()) {
      if (interaction.customId.startsWith("stats:period:")) {
        await handleStatsPeriodButton(interaction);
        return;
      }
    }

    // Quote (message context menu)
    if (interaction.isMessageContextMenuCommand()) {
      if (interaction.commandName === "Quote") {
        // Acknowledge the interaction so Discord doesn't show "interaction failed"
        await interaction.deferReply({ ephemeral: true });

        const message = interaction.targetMessage;

        const buffer = await renderQuoteImage({
          message,
          guild: interaction.guild,
        });

        const QUOTE_CHANNEL_ID = "1226401843635032074";

        const quoteChannel = await interaction.guild.channels
          .fetch(QUOTE_CHANNEL_ID)
          .catch(() => null);

        if (!quoteChannel || !quoteChannel.isTextBased()) {
          await interaction.editReply({
            content: "Quote channel not found or not a text channel.",
          });
          return;
        }

        await quoteChannel.send({
          files: [{ attachment: buffer, name: "quote.png" }],
        });

        // Quiet confirmation to the person who used the command
        await interaction.editReply({ content: "Posted quote." });

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

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

await DB.init();
await registerCommands();
await client.login(token);
