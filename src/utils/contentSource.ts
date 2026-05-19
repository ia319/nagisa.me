import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/config";

export type ParsedLocalizedSourceId = {
  baseId: string;
  locale: Locale;
};

export function parseLocalizedSourceId(
  sourceId: string
): ParsedLocalizedSourceId {
  const pathSegments = sourceId.split("/");
  const filename = pathSegments.pop() ?? sourceId;
  const match = filename.match(/^(.*)\.([^.]+)$/);

  if (!match || !isLocale(match[2])) {
    return { baseId: sourceId, locale: DEFAULT_LOCALE };
  }

  const baseFilename = match[1];
  const baseId = [...pathSegments, baseFilename].filter(Boolean).join("/");
  return { baseId, locale: match[2] };
}

export function getRelativeContentFilePath(
  filePath: string | undefined,
  contentPath: string
) {
  if (!filePath) return undefined;

  const normalizedFilePath = filePath.replaceAll("\\", "/");
  const normalizedContentPath = contentPath
    .replaceAll("\\", "/")
    .replace(/^\.?\//, "");
  const contentPathIndex = normalizedFilePath.indexOf(
    `${normalizedContentPath}/`
  );

  if (contentPathIndex < 0) return undefined;

  return normalizedFilePath.slice(
    contentPathIndex + normalizedContentPath.length + 1
  );
}

export function getSourceIdFromContentFilePath(
  filePath: string | undefined,
  contentPath: string
) {
  const relativeFilePath = getRelativeContentFilePath(filePath, contentPath);

  return relativeFilePath?.replace(/\.[^/.]+$/, "");
}
