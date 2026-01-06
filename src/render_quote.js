import { createCanvas, loadImage } from "@napi-rs/canvas";
import https from "https";

function fetchImageBuffer(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          return reject(
            new Error(`Failed to get image. Status code: ${res.statusCode}`)
          );
        }
        const data = [];
        res.on("data", (chunk) => data.push(chunk));
        res.on("end", () => resolve(Buffer.concat(data)));
      })
      .on("error", reject);
  });
}

function parseMessageTokens(text, channels, users) {
  const tokens = [];
  const regex = /(<#(\d+)>|<@(\d+)>|[^<]+)/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match[2]) {
      const id = match[2];
      const name = channels?.[id]?.name || "deleted-channel";
      tokens.push({ type: "channel", text: `#${name}` });
    } else if (match[3]) {
      const id = match[3];
      const name = users?.[id]?.username || "unknown-user";
      tokens.push({ type: "user", text: `@${name}` });
    } else {
      tokens.push({ type: "text", text: match[0] });
    }
  }
  return tokens;
}

function measureTokenLines(ctx, tokens, maxWidth) {
  let cursorX = 0;
  let lines = 1;

  for (const token of tokens) {
    const parts = token.text.split(/(\s+)/);
    for (const part of parts) {
      const w = ctx.measureText(part).width;
      if (cursorX + w > maxWidth && cursorX > 0) {
        lines++;
        cursorX = 0;
      }
      cursorX += w;
    }
  }

  return lines;
}

function drawTokens(ctx, tokens, x, y, maxWidth, lineHeight) {
  let cursorX = x;
  let cursorY = y;

  for (const token of tokens) {
    const parts = token.text.split(/(\s+)/);

    for (const part of parts) {
      const w = ctx.measureText(part).width;

      if (cursorX + w > x + maxWidth && cursorX > x) {
        cursorY += lineHeight;
        cursorX = x;
      }

      if (token.type === "channel" || token.type === "user") {
        // blue pill highlight
        const pillPadX = 4;
        const pillPadY = 4;

        // background pill
        ctx.fillStyle = "#5865f2";
        ctx.fillRect(
          cursorX - pillPadX / 2,
          cursorY - lineHeight + pillPadY,
          w + pillPadX,
          lineHeight
        );

        // text
        ctx.fillStyle = "#ffffff";
        ctx.fillText(part, cursorX, cursorY);

        cursorX += w;
      } else {
        ctx.fillStyle = "#dcddde";
        ctx.fillText(part, cursorX, cursorY);
        cursorX += w;
      }
    }
  }
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  const date = d.toLocaleDateString(undefined, {
    month: "numeric",
    day: "numeric",
    year: "numeric",
  });
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${date} ${time}`;
}

/**
 * Old-style quote renderer, but on @napi-rs/canvas (no node-canvas dependency).
 * This matches your previous look closely.
 */
export async function renderQuoteImage({ message }) {
  const content = message?.content ?? "";
  const author = message?.author;
  const member = message?.member;

  const username = member?.displayName || author?.username || "Unknown";
  const timestamp = message?.createdTimestamp ?? Date.now();

  // Build channel/user maps for <#id> and <@id> token rendering
  const channels = {};
  if (message?.guild?.channels?.cache) {
    for (const [id, ch] of message.guild.channels.cache) {
      channels[id] = { name: ch?.name };
    }
  }

  const users = {};
  // Include mentioned users (best effort)
  if (message?.mentions?.users) {
    for (const [id, u] of message.mentions.users) {
      users[id] = { username: u?.username };
    }
  }
  // Ensure author is resolvable too
  if (author?.id) users[author.id] = { username: author.username };

  const avatarURL =
    author?.displayAvatarURL?.({ extension: "png", size: 128 }) ||
    author?.avatarURL?.() ||
    null;

  // Layout constants (matching old)
  const W = 800;
  const paddingY = 20;
  const avatarSize = 56;
  const avatarX = 20;
  const avatarY = paddingY;

  const baseFontSize = 16;
  const usernameFont = `600 ${baseFontSize + 4}px "gg sans"`;
  const timeFont = `500 ${baseFontSize - 0}px "gg sans"`;
  const messageFont = `400 ${baseFontSize + 2}px "gg sans"`;
  const lineHeight = baseFontSize + 6;

  const nameX = avatarX + avatarSize + 14;
  const nameY = avatarY + 20;

  // Measure content to compute height
  const tmp = createCanvas(W, 10);
  const tctx = tmp.getContext("2d");
  tctx.font = messageFont;

  const tokens = parseMessageTokens(content, channels, users);
  const maxTextWidth = 680;
  const lines = Math.max(1, measureTokenLines(tctx, tokens, maxTextWidth));

  // Dynamic height similar to old, but supports multi-line
  const headerH = 56;
  const bodyH = lines * lineHeight;
  const H = paddingY * 2 + headerH + bodyH;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // Background (old color)
  ctx.fillStyle = "#2b2d31";
  ctx.fillRect(0, 0, W, H);

  // Avatar
  if (avatarURL) {
    try {
      const buf = await fetchImageBuffer(avatarURL);
      const avatar = await loadImage(buf);

      ctx.save();
      ctx.beginPath();
      ctx.arc(
        avatarX + avatarSize / 2,
        avatarY + avatarSize / 2,
        avatarSize / 2,
        0,
        Math.PI * 2
      );
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize);
      ctx.restore();
    } catch {
      // fallback: just a circle
      ctx.fillStyle = "#1f2125";
      ctx.beginPath();
      ctx.arc(
        avatarX + avatarSize / 2,
        avatarY + avatarSize / 2,
        avatarSize / 2,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
  }

  // Username (role color if available)
  let nameColor = "#ffffff";
  const displayColor = member?.displayColor;
  if (typeof displayColor === "number" && displayColor !== 0) {
    nameColor = `#${displayColor.toString(16).padStart(6, "0")}`;
  }

  // --- Header layout (clip username, fixed 6px gap before time) ---
  const nameTimeGap = 6;
  const headerRightPad = 20;
  const headerMaxX = W - headerRightPad;

  // Timestamp text/width
  ctx.font = timeFont;
  ctx.fillStyle = "#b0b0b0";
  const timeText = " " + formatTimestamp(timestamp);
  const timeWidth = ctx.measureText(timeText).width;

  // Compute max width allowed for username so time always fits
  const maxNameWidth = (headerMaxX - nameX) - nameTimeGap - timeWidth;

  // Draw username clipped (no "...")
  ctx.save();
  ctx.beginPath();
  ctx.rect(
    nameX,
    nameY - (baseFontSize + 6),
    Math.max(0, maxNameWidth),
    baseFontSize + 12
  );
  ctx.clip();

  ctx.font = usernameFont;
  const nameWidth = ctx.measureText(username).width;

  ctx.fillStyle = nameColor;
  ctx.fillText(username, nameX, nameY);
  ctx.restore();

  // Draw timestamp after the reserved username region + gap
  ctx.font = timeFont;
  ctx.fillStyle = "#b0b0b0";
  const effectiveNameWidth = Math.min(nameWidth, maxNameWidth);
  const timeX = nameX + effectiveNameWidth + nameTimeGap;

  ctx.fillText(timeText, timeX, nameY);
  // --- End header layout ---

  // Message content
  ctx.font = messageFont;
  drawTokens(ctx, tokens, nameX, nameY + 26, maxTextWidth, lineHeight);

  return canvas.toBuffer("image/png");
}
