// ban.js
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
} from "discord.js";

const BAN_LOG_CHANNEL_ID = "1096995931989217321";

export const banCommand = new SlashCommandBuilder()
  .setName("ban")
  .setDescription("Ban a member from the server")
  .addUserOption((option) =>
    option
      .setName("user")
      .setDescription("The user to ban")
      .setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName("reason")
      .setDescription("Reason for the ban")
      .setRequired(false)
  )
  // Only members with Ban Members permission can see/use the command
  .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers);

export async function handleBan(interaction) {
  await interaction.deferReply({ ephemeral: true });

  if (!interaction.inGuild()) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  const target = interaction.options.getUser("user", true);
  const reason =
    interaction.options.getString("reason") ?? "No reason provided";

  const member = await interaction.guild.members
    .fetch(target.id)
    .catch(() => null);

  if (!member) {
    await interaction.editReply("User not found in this guild.");
    return;
  }

  // Discord role hierarchy / permission check
  if (!member.bannable) {
    await interaction.editReply("I cannot ban this user (role/permission issue).");
    return;
  }

  //await member.ban({ reason });

  // Log to a hard-coded channel
  const logChannel = await interaction.guild.channels
    .fetch(BAN_LOG_CHANNEL_ID)
    .catch(() => null);

  if (logChannel?.isTextBased()) {
    await logChannel.send({
    content:
        `**RIP** :headstone: \`${target.tag}\` ||${target.id}||\n` +
        `Banned for ${reason}\n` +
        `Banned by <@${interaction.user.id}>`,
    allowedMentions: { users: [interaction.user.id] },
    });
  }

  await interaction.editReply(`Banned **${target.tag}** successfully.`);
}
