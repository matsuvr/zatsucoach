export const STAGE_TRANSCRIPT_LIMIT = 4;
export const STAGE_ADVICE_TEXT_LIMIT = 96;
export const STAGE_BUBBLE_DEFAULT_MAX_PX = 520;
export const STAGE_BUBBLE_MIN_PX = 72;
export const STAGE_BUBBLE_AVATAR_GAP_PX = 22;
export const STAGE_BUBBLE_EDGE_INSET_PX = 26;

export function calculateStageBubbleMaxWidth(availableWidth) {
  return Math.max(
    STAGE_BUBBLE_MIN_PX,
    Math.min(STAGE_BUBBLE_DEFAULT_MAX_PX, Math.floor(availableWidth))
  );
}

export function normalizeStageText(text) {
  return String(text || '')
    .replace(/\s*理由:\s*/g, '\n理由: ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function compactStageText(text, limit) {
  const normalized = normalizeStageText(text);
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trim()}…`;
}

export function wrapCanvasText(ctx, text, maxWidth, maxLines, truncate = true) {
  return layoutCanvasText(ctx, text, maxWidth, maxLines, truncate).lines;
}

export function fitCanvasText(ctx, text, {
  maxWidth,
  maxLines,
  fontSize,
  minFontSize = fontSize,
  truncate = true
}) {
  const minSize = Math.max(1, Math.min(fontSize, minFontSize));
  for (let size = fontSize; size >= minSize; size -= 2) {
    setCanvasTextFont(ctx, size);
    const layout = layoutCanvasText(ctx, text, maxWidth, maxLines, false);
    if (!layout.truncated && layout.lines.every((line) => ctx.measureText(line).width <= maxWidth)) {
      return { fontSize: size, lines: layout.lines };
    }
  }

  setCanvasTextFont(ctx, minSize);
  return {
    fontSize: minSize,
    lines: layoutCanvasText(ctx, text, maxWidth, maxLines, truncate).lines
  };
}

export function layoutCanvasText(ctx, text, maxWidth, maxLines, truncate = true) {
  const source = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!source) return { lines: [''], truncated: false };
  const lineLimit = Number.isFinite(maxLines) ? Math.max(1, maxLines) : Infinity;
  const paragraphs = source.split('\n');
  const lines = [];
  let truncated = false;

  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 1) {
    if (lines.length >= lineLimit) {
      truncated = true;
      break;
    }

    const paragraph = paragraphs[paragraphIndex];
    if (!paragraph) {
      lines.push('');
      continue;
    }

    const units = Array.from(paragraph);
    let line = '';
    for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
      const unit = units[unitIndex];
      const next = `${line}${unit}`;
      if (ctx.measureText(next).width <= maxWidth || !line) {
        line = next;
        continue;
      }

      if (lines.length >= lineLimit) {
        truncated = true;
        break;
      }
      lines.push(line.trim());
      line = unit;
      if (truncate && lines.length === lineLimit) {
        truncated = true;
        break;
      }
    }

    if (truncated) break;
    if (line) {
      if (lines.length >= lineLimit) {
        truncated = true;
        break;
      }
      lines.push(line.trim());
    }
  }

  if (truncate && truncated && lines.length) {
    lines[lines.length - 1] = fitCanvasEllipsis(ctx, lines[lines.length - 1], maxWidth);
  }
  return { lines: lines.length ? lines : [''], truncated };
}

export function fitCanvasEllipsis(ctx, text, maxWidth) {
  const units = Array.from(String(text || '').replace(/…$/, '').trim());
  while (units.length && ctx.measureText(`${units.join('')}…`).width > maxWidth) units.pop();
  return `${units.join('')}…`;
}

export function setCanvasTextFont(ctx, fontSize) {
  ctx.font = `600 ${fontSize}px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
}

export function drawBubbleShape(ctx, x, y, width, height, radius, tail, tailSize) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  if (tail === 'right') {
    ctx.lineTo(x + width, y + height - 78);
    ctx.lineTo(x + width + tailSize - 8, y + height - 48);
    ctx.lineTo(x + width, y + height - 26);
  } else {
    ctx.lineTo(x + width, y + height - radius);
  }
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  if (tail === 'avatar' || tail === 'user') {
    const baseCenter = tail === 'avatar' ? x + width * 0.72 : x + width * 0.68;
    const tipX = tail === 'avatar' ? baseCenter + tailSize * 0.42 : baseCenter - tailSize * 0.34;
    const tipY = y + height + tailSize - 8;
    const baseHalf = tailSize * 0.48;
    ctx.lineTo(baseCenter + baseHalf, y + height);
    ctx.lineTo(tipX, tipY);
    ctx.lineTo(baseCenter - baseHalf, y + height);
  }
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  if (tail === 'left') {
    ctx.lineTo(x, y + height - 26);
    ctx.lineTo(x - tailSize + 8, y + height - 48);
    ctx.lineTo(x, y + height - 78);
  }
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}
