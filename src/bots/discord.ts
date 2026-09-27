/**
 * Discord bot — slash commands + block streaming + button approvals.
 *
 * Commands:
 *   /zcode ask <prompt>       general question (same agent brain)
 *   /zcode code <prompt>      coding task against the workspace
 *   /zcode plan <prompt>      plan-only run
 *   /zcode stop               abort the current run in this channel
 *   /zcode new                fresh session for this channel
 *   /zcode status             model, mode, session id, context usage
 *
 * Guardrails: user allowlist (first user to /zcode becomes owner if list
 * empty), mention requirement configurable, all outbound text scrubbed.
 */
import path from "node:path";
import fs from "node:fs";
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import type { ChatInputCommandInteraction, Interaction, Message, ButtonInteraction } from "discord.js";
import { BotBrain, outbound, chunkForPlatform } from "./shared.js";
type SendableChannel = { send: (o: unknown) => Promise<any>; sendTyping?: () => Promise<void>; messages: { fetch: (id: string) => Promise<any> } };
import { makeSafety, type ApprovalRequest, type ApprovalDecision, MODE_INFO } from "../safety/safety.js";
import type { Config } from "../config/config.js";
import { VERSION, errMessage, truncate } from "../util.js";

const SLASH_DEFS = [
  {
    name: "zcode",
    description: "ZCode Ultra coding agent",
    options: [
      { name: "ask", description: "Ask anything (uses the workspace agent)", type: 3, required: true },
      { name: "mode", description: "Internal", type: 1 },
    ],
  },
];

interface DiscordBotOptions {
  cfg: Config;
  workspace: string;
  args: { flags: Record<string, string | boolean> };
}

export async function startDiscordBot(opts: DiscordBotOptions): Promise<void> {
  const { cfg, workspace } = opts;
  const token = process.env[cfg.discord.tokenEnv];
  if (!token) {
    console.error(`Missing Discord token. Set ${cfg.discord.tokenEnv} (see docs/DISCORD.md).`);
    process.exit(1);
  }

  const brain = new BotBrain(cfg, workspace);
  const allowUsers = new Set(cfg.botGuard.discordAllowUsers ?? []);
  let ownerAnnounced = false;

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel],
  });

  client.once(Events.ClientReady, async (c) => {
    console.log(`Discord bot online as ${c.user.tag}`);
    console.log(`Workspace: ${workspace}   Model: ${cfg.model}   Mode: ${cfg.permissionMode}`);
    await registerCommands(c.application.id, token);
    console.log("Slash commands registered. Invite the bot with applications.commands scope.");
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    try {
      if (interaction.isButton()) {
        await handleButton(interaction as ButtonInteraction);
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      const cmd = interaction as ChatInputCommandInteraction;
      if (cmd.commandName !== "zcode") return;

      // guard: allowlist
      if (allowUsers.size > 0 && !allowUsers.has(cmd.user.id)) {
        await cmd.reply({ content: "You are not allowlisted to use this bot.", ephemeral: true });
        return;
      }
      if (allowUsers.size === 0 && !ownerAnnounced) {
        allowUsers.add(cmd.user.id);
        ownerAnnounced = true;
        console.log(`First user became bot owner: ${cmd.user.tag} (${cmd.user.id})`);
      }

      const prompt = cmd.options.getString("prompt") ?? "";
      const isPlan = cmd.options.getBoolean("plan") ?? false;
      if (!prompt.trim()) {
        await cmd.reply({ content: "Provide a prompt.", ephemeral: true });
        return;
      }
      await handleZcodeCommand(cmd, prompt, isPlan);
    } catch (e) {
      console.error("interaction error:", errMessage(e));
    }
  });

  async function handleZcodeCommand(cmd: ChatInputCommandInteraction, prompt: string, isPlan: boolean): Promise<void> {
    await cmd.deferReply();
    const chatKey = `discord:${cmd.channelId}`;
    const reply = await cmd.fetchReply();
    let lastPreviewMessageId = reply.id;

    await brain.enqueue({
      chatKey,
      user: cmd.user.username,
      text: prompt,
      onThinking: async () => {},
      onPreview: async (current) => {
        const text = outbound(current);
        const chunk = chunkForPlatform(text, 1900).slice(-1)[0] ?? "…";
        try {
          const msg = await cmd.channel!.messages.fetch(lastPreviewMessageId);
          await msg.edit(`**▌working…**\n${truncate(chunk, 1900)}`);
        } catch {
          /* message deleted — ignore */
        }
      },
      onFinal: async (finalText) => {
        const text = outbound(isPlan ? `**PLAN MODE**\n\n${finalText}` : finalText);
        const chunks = chunkForPlatform(text, 1900);
        try {
          // reuse the preview message for the first chunk
          const msg = await cmd.channel!.messages.fetch(lastPreviewMessageId);
          await msg.edit(chunks[0] ?? "(empty)");
          for (const c of chunks.slice(1)) {
            await (cmd.channel as unknown as SendableChannel).send(c);
          }
        } catch (e) {
          await cmd.followUp(truncate(text, 1900)).catch(() => {});
        }
      },
      approve: async (req) => discordApproval(cmd, req),
      planMode: isPlan,
      maxTurns: isPlan ? 24 : cfg.maxTurns,
    });
  }

  const pendingApprovals = new Map<string, (d: ApprovalDecision) => void>();

  async function discordApproval(cmd: ChatInputCommandInteraction, req: ApprovalRequest): Promise<ApprovalDecision> {
    if (!cmd.channel) return { approved: false, reason: "no channel" };
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("approve").setLabel("Approve").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("deny").setLabel("Deny").setStyle(ButtonStyle.Danger)
    );
    const embed = new EmbedBuilder()
      .setTitle(`Approval needed — ${req.tool} [${req.risk.toUpperCase()}]`)
      .setDescription(truncate(req.summary, 500))
      .setFooter({ text: `cwd: ${req.cwd ?? workspace}` });
    const msg = await (cmd.channel as unknown as SendableChannel).send({ embeds: [embed], components: [row] });
    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        pendingApprovals.delete(msg.id);
        void msg.edit({ embeds: [embed.setTitle("Approval timed out (denied)")], components: [] });
        resolve({ approved: false, reason: "timeout" });
      }, 120_000);
      pendingApprovals.set(msg.id, (d) => {
        clearTimeout(timer);
        void msg.edit({ components: [] });
        resolve(d);
      });
    });
  }

  async function handleButton(interaction: ButtonInteraction): Promise<void> {
    const resolver = pendingApprovals.get(interaction.message.id);
    if (!resolver) {
      await interaction.reply({ content: "This approval is no longer active.", ephemeral: true });
      return;
    }
    if (allowUsers.size > 0 && !allowUsers.has(interaction.user.id)) {
      await interaction.reply({ content: "Not allowlisted.", ephemeral: true });
      return;
    }
    pendingApprovals.delete(interaction.message.id);
    if (interaction.customId === "approve") {
      resolver({ approved: true, reason: "approved via Discord" });
      await interaction.reply({ content: "✅ Approved", ephemeral: true });
    } else {
      resolver({ approved: false, reason: "denied via Discord" });
      await interaction.reply({ content: "❌ Denied", ephemeral: true });
    }
  }

  async function registerCommands(applicationId: string, token_: string): Promise<void> {
    const { REST, Routes } = await import("discord.js");
    const rest = new REST({ version: "10" }).setToken(token_);
    const commands = [
      {
        name: "zcode",
        description: "Run the ZCode Ultra agent",
        options: [
          { name: "prompt", description: "What should the agent do?", type: 3, required: true },
          { name: "plan", description: "Plan only (no writes)", type: 5, required: false },
        ],
      },
    ];
    try {
      await rest.put(Routes.applicationCommands(applicationId), { body: commands });
    } catch (e) {
      console.error("Failed to register slash commands:", errMessage(e));
    }
  }

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    // In DMs always respond; in guilds respond to mentions
    const mentioned = message.mentions.users.has(client.user!.id);
    const isDM = !message.guild;
    if (!isDM && cfg.botGuard.requireMentionInGuilds !== false && !mentioned) return;
    if (allowUsers.size > 0 && !allowUsers.has(message.author.id)) return;

    const prompt = message.content.replace(/<@!?\d+>/g, "").trim();
    if (!prompt) return;
    const chatKey = `discord:${message.channelId}`;

    await (message.channel as unknown as { sendTyping: () => Promise<void> }).sendTyping();
    const preview = await (message.channel as unknown as SendableChannel).send("**▌thinking…**");
    await brain.enqueue({
      chatKey,
      user: message.author.username,
      text: prompt,
      onThinking: async () => {},
      onPreview: async (current) => {
        const chunk = chunkForPlatform(outbound(current), 1900).slice(-1)[0] ?? "…";
        await preview.edit(`**▌working…**\n${truncate(chunk, 1900)}`).catch(() => {});
      },
      onFinal: async (finalText) => {
        const chunks = chunkForPlatform(outbound(finalText), 1900);
        await preview.edit(chunks[0] ?? "(empty)").catch(() => {});
        for (const c of chunks.slice(1)) await (message.channel as unknown as SendableChannel).send(c).catch(() => {});
      },
      approve: null,
    });
  });

  client.on("error", (e) => console.error("discord error:", e.message));
  await client.login(token);
}

void SLASH_DEFS;
void path;
void fs;
