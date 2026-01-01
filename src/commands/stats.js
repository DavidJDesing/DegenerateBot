import {
  SlashCommandBuilder,
  AttachmentBuilder,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { DB } from "../db.js";
import { resolveRange, ensureSeriesDays, formatHMS } from "../periods.js";
import { renderStatsCard } from "../render.js";

const PERIODS = ["3d", "7d", "30d", "90d", "all"];

function buildPeriodButtons({ mode, targetId, activePeriod }) {
  // customId format:
  // stats:period:<mode>:<targetId>:<period>
  // mode = "user" | "channel"
  const row = new ActionRowBuilder();

  for (const p of PERIODS) {
    const label =
      p === "all" ? "All" : p.toUpperCase(); // 3D, 7D, 30D, 90D, All

    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`stats:period:${mode}:${targetId}:${p}`)
        .setLabel(label)
        .setStyle(p === activePeriod ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(p === activePeriod)
    );
  }

  return [row];
}

export const statsCommand = new SlashCommandBuilder()
  .setName("stats")
  .setDescription("Show user or channel activity stats with a chart.")
  .addSubcommand((sub) =>
    sub
      .setName("user")
      .setDescription("User stats (messages + voice time).")
      .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
      .addStringOption((o) =>
        o
          .setName("period")
          .setDescription("3d, 7d, 30d, 90d, all, or custom")
          .setRequired(false)
          .addChoices(
            { name: "3d", value: "3d" },
            { name: "7d", value: "7d" },
            { name: "30d", value: "30d" },
            { name: "90d", value: "90d" },
            { name: "All time", value: "all" },
            { name: "Custom (use from/to)", value: "custom" }
          )
      )
      .addStringOption((o) => o.setName("from").setDescription("YYYY-MM-DD (custom only)").setRequired(false))
      .addStringOption((o) => o.setName("to").setDescription("YYYY-MM-DD (custom only)").setRequired(false))
  )
  .addSubcommand((sub) =>
    sub
      .setName("channel")
      .setDescription("Channel stats (messages + voice time).")
      .addChannelOption((o) =>
        o
          .setName("channel")
          .setDescription("Text/voice channel")
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice)
      )
      .addStringOption((o) =>
        o
          .setName("period")
          .setDescription("3d, 7d, 30d, 90d, all, or custom")
          .setRequired(false)
          .addChoices(
            { name: "3d", value: "3d" },
            { name: "7d", value: "7d" },
            { name: "30d", value: "30d" },
            { name: "90d", value: "90d" },
            { name: "All time", value: "all" },
            { name: "Custom (use from/to)", value: "custom" }
          )
      )
      .addStringOption((o) => o.setName("from").setDescription("YYYY-MM-DD (custom only)").setRequired(false))
      .addStringOption((o) => o.setName("to").setDescription("YYYY-MM-DD (custom only)").setRequired(false))
  );

export async function handleStats(interaction) {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  const periodOpt = interaction.options.getString("period") ?? "30d";
  const from = interaction.options.getString("from");
  const to = interaction.options.getString("to");

  const range = resolveRange({
    period: periodOpt === "custom" ? undefined : periodOpt,
    from: periodOpt === "custom" ? from : undefined,
    to: periodOpt === "custom" ? to : undefined,
  });

  if (periodOpt === "custom" && (!from || !to)) {
    await interaction.reply({
      content: "For custom range, provide both `from` and `to` as YYYY-MM-DD.",
      ephemeral: true,
    });
    return;
  }

  // Buttons only support the preset periods. For "custom", we do not attach buttons.
  const activePeriod = PERIODS.includes(periodOpt) ? periodOpt : "30d";

  if (sub === "user") {
    const user = interaction.options.getUser("user", true);

    const totals = await DB.sumUserRange(guildId, user.id, range.start, range.end);
    const rawSeries = await DB.seriesUserRange(guildId, user.id, range.start, range.end);
    const series = ensureSeriesDays(rawSeries, range.start, range.end);

    const png = renderStatsCard({
      title: `${user.username}`,
      subtitle: "User activity",
      rangeLabel: range.label,
      totals,
      series,
    });

    const file = new AttachmentBuilder(png, { name: "stats.png" });

    const components =
      periodOpt === "custom"
        ? []
        : buildPeriodButtons({ mode: "user", targetId: user.id, activePeriod });

    await interaction.reply({
      content: `Messages: **${totals.messages}** • Voice: **${formatHMS(totals.voice_seconds)}**`,
      files: [file],
      components,
    });
    return;
  }

  if (sub === "channel") {
    const channel = interaction.options.getChannel("channel", true);

    const totals = await DB.sumChannelRange(guildId, channel.id, range.start, range.end);
    const rawSeries = await DB.seriesChannelRange(guildId, channel.id, range.start, range.end);
    const series = ensureSeriesDays(rawSeries, range.start, range.end);

    const png = renderStatsCard({
      title: `#${channel.name ?? channel.id}`,
      subtitle: "Channel activity",
      rangeLabel: range.label,
      totals,
      series,
    });

    const file = new AttachmentBuilder(png, { name: "stats.png" });

    const components =
      periodOpt === "custom"
        ? []
        : buildPeriodButtons({ mode: "channel", targetId: channel.id, activePeriod });

    await interaction.reply({
      content: `Messages: **${totals.messages}** • Voice: **${formatHMS(totals.voice_seconds)}**`,
      files: [file],
      components,
    });
  }
}

export async function handleStatsPeriodButton(interaction) {
  // customId: stats:period:<mode>:<targetId>:<period>
  const parts = interaction.customId.split(":");
  if (parts.length !== 5) return;

  const mode = parts[2]; // "user" | "channel"
  const targetId = parts[3]; // userId or channelId
  const period = parts[4]; // 3d|7d|30d|90d|all

  if (!PERIODS.includes(period)) {
    await interaction.reply({ content: "Invalid period.", ephemeral: true });
    return;
  }

  const guildId = interaction.guildId;
  const range = resolveRange({ period });

  await interaction.deferUpdate();

  if (mode === "user") {
    const user = await interaction.client.users.fetch(targetId).catch(() => null);
    if (!user) {
      await interaction.editReply({ content: "User not found.", components: [], files: [] }).catch(() => {});
      return;
    }

    const totals = await DB.sumUserRange(guildId, user.id, range.start, range.end);
    const rawSeries = await DB.seriesUserRange(guildId, user.id, range.start, range.end);
    const series = ensureSeriesDays(rawSeries, range.start, range.end);

    const png = renderStatsCard({
      title: `${user.username}`,
      subtitle: "User activity",
      rangeLabel: range.label,
      totals,
      series,
    });

    const file = new AttachmentBuilder(png, { name: "stats.png" });

    await interaction.editReply({
      content: `Messages: **${totals.messages}** • Voice: **${formatHMS(totals.voice_seconds)}**`,
      files: [file],
      components: buildPeriodButtons({ mode: "user", targetId: user.id, activePeriod: period }),
    });

    return;
  }

  if (mode === "channel") {
    const channel = await interaction.guild.channels.fetch(targetId).catch(() => null);
    if (!channel) {
      await interaction.editReply({ content: "Channel not found.", components: [], files: [] }).catch(() => {});
      return;
    }

    const totals = await DB.sumChannelRange(guildId, channel.id, range.start, range.end);
    const rawSeries = await DB.seriesChannelRange(guildId, channel.id, range.start, range.end);
    const series = ensureSeriesDays(rawSeries, range.start, range.end);

    const png = renderStatsCard({
      title: `#${channel.name ?? channel.id}`,
      subtitle: "Channel activity",
      rangeLabel: range.label,
      totals,
      series,
    });

    const file = new AttachmentBuilder(png, { name: "stats.png" });

    await interaction.editReply({
      content: `Messages: **${totals.messages}** • Voice: **${formatHMS(totals.voice_seconds)}**`,
      files: [file],
      components: buildPeriodButtons({ mode: "channel", targetId: channel.id, activePeriod: period }),
    });
  }
}
