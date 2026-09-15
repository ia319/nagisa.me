import path from "node:path";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type Locale } from "@/i18n/config";
import {
  parseLocalizedContentIdentity,
  validateLocalizedContentIdentities,
} from "./localizedContentIdentity.mjs";

export type ParsedLocalizedSourceId = {
  baseId: string;
  hasLocaleSuffix: boolean;
  locale: Locale;
};

const identityConfig = {
  defaultLocale: DEFAULT_LOCALE,
  supportedLocales: SUPPORTED_LOCALES,
};

export function parseLocalizedSourceId(
  sourceId: string
): ParsedLocalizedSourceId {
  return parseLocalizedContentIdentity(
    sourceId,
    identityConfig
  ) as ParsedLocalizedSourceId;
}

/**
 * Validate localized source identities using the shared locale registry.
 * @param sourceIds Extension-free, content-root-relative source IDs.
 * @returns Parsed identities in the same order as the input.
 * @throws {Error} When localized variants violate the filename contract.
 */
export function validateLocalizedSourceIds(
  sourceIds: readonly string[]
): ParsedLocalizedSourceId[] {
  return validateLocalizedContentIdentities(
    sourceIds,
    identityConfig
  ) as ParsedLocalizedSourceId[];
}

export function getRelativeContentFilePath(
  filePath: string | undefined,
  contentPath: string
) {
  if (!filePath) return undefined;

  const relativeFilePath = path.relative(
    path.resolve(contentPath),
    path.resolve(filePath)
  );

  if (
    !relativeFilePath ||
    relativeFilePath.startsWith("..") ||
    path.isAbsolute(relativeFilePath)
  ) {
    return undefined;
  }

  return relativeFilePath.replaceAll(path.sep, "/");
}

export function getSourceIdFromContentFilePath(
  filePath: string | undefined,
  contentPath: string
) {
  const relativeFilePath = getRelativeContentFilePath(filePath, contentPath);

  return relativeFilePath?.replace(/\.[^/.]+$/, "");
}
