import kebabcase from "lodash.kebabcase";
import slugify from "slugify";

/**
 * Generate the same hybrid slug for site routes and Node content tools.
 * @param {string} value Display text to convert.
 * @returns {string} Lowercase slug retaining non-Latin characters.
 */
export function slugifyStr(value) {
  // Preserve non-Latin scripts while retaining the existing ASCII slug rules.
  return /[^\x00-\x7F]/.test(value)
    ? kebabcase(value)
    : slugify(value, { lower: true });
}

/**
 * Generate slugs for a list of display labels.
 * @param {string[]} values Display labels in input order.
 * @returns {string[]} Slugs in the same order.
 */
export const slugifyAll = values => values.map(slugifyStr);
