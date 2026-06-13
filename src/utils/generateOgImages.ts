import { Resvg } from "@resvg/resvg-js";
import { type CollectionEntry } from "astro:content";
import { SITE } from "@/config";
import postOgImage from "./og-templates/post";
import siteOgImage from "./og-templates/site";
import { isFontLoadError } from "./loadGoogleFont";

const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

let hasWarnedFontFallback = false;

function svgBufferToPngBuffer(svg: string) {
  const resvg = new Resvg(svg);
  const pngData = resvg.render();
  return pngData.asPng();
}

function escapeSvgText(value: string) {
  return value.replace(
    /[&<>"']/g,
    char =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[char] ?? char
  );
}

function wrapText(value: string, maxChars: number, maxLines: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  const lines: string[] = [];
  let remaining = normalized;

  while (remaining.length > 0 && lines.length < maxLines) {
    if (remaining.length <= maxChars) {
      lines.push(remaining);
      break;
    }

    const slice = remaining.slice(0, maxChars);
    const lastSpaceIndex = slice.lastIndexOf(" ");
    const breakIndex = lastSpaceIndex > 0 ? lastSpaceIndex : maxChars - 1;
    const line = remaining.slice(0, breakIndex).trim();
    lines.push(line);
    remaining = remaining.slice(breakIndex).trim();
  }

  if (remaining.length > 0 && lines.length === maxLines) {
    const lastLine = lines[lines.length - 1] ?? "";
    lines[lines.length - 1] = `${lastLine.slice(0, maxChars - 3).trimEnd()}...`;
  }

  return lines.length > 0 ? lines : [""];
}

function renderTspans(
  lines: string[],
  x: number,
  y: number,
  lineHeight: number
) {
  return lines
    .map(
      (line, index) =>
        `<tspan x="${x}" y="${y + index * lineHeight}">${escapeSvgText(line)}</tspan>`
    )
    .join("");
}

function createFallbackOgSvg({
  description,
  footer,
  title,
}: {
  description: string;
  footer: string;
  title: string;
}) {
  const titleLines = wrapText(title, 24, 3);
  const descriptionLines = wrapText(description, 48, 2);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}">
  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="#fefbfb"/>
  <rect x="54" y="54" width="1064" height="500" rx="4" fill="#ecebeb" stroke="#000" stroke-width="4" opacity="0.9"/>
  <rect x="80" y="78" width="1064" height="500" rx="4" fill="#fefbfb" stroke="#000" stroke-width="4"/>
  <text font-family="Arial, Helvetica, sans-serif" font-size="68" font-weight="700" fill="#282728">
    ${renderTspans(titleLines, 128, 190, 82)}
  </text>
  <text font-family="Arial, Helvetica, sans-serif" font-size="28" fill="#282728">
    ${renderTspans(descriptionLines, 128, 430, 40)}
  </text>
  <text x="1072" y="520" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="700" fill="#282728">${escapeSvgText(footer)}</text>
</svg>`;
}

function warnFontFallback(error: unknown) {
  if (hasWarnedFontFallback) return;

  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `[og-image] ${message}. Generated fallback OG image without remote fonts.\n`
  );
  hasWarnedFontFallback = true;
}

async function renderOgSvg(
  renderPrimary: () => Promise<string>,
  fallback: string
) {
  try {
    return await renderPrimary();
  } catch (error) {
    if (!isFontLoadError(error)) throw error;

    warnFontFallback(error);
    return fallback;
  }
}

export async function generateOgImageForPost(post: CollectionEntry<"blog">) {
  const svg = await renderOgSvg(
    () => postOgImage(post),
    createFallbackOgSvg({
      title: post.data.title,
      description: `by ${post.data.author}`,
      footer: SITE.title,
    })
  );
  return svgBufferToPngBuffer(svg);
}

export async function generateOgImageForSite() {
  const svg = await renderOgSvg(
    () => siteOgImage(),
    createFallbackOgSvg({
      title: SITE.title,
      description: SITE.desc,
      footer: new URL(SITE.website).hostname,
    })
  );
  return svgBufferToPngBuffer(svg);
}
