import { DEFAULT_LOCALE, type Locale } from "./config";
import { UI_DICTIONARIES } from "./ui-dictionaries.mjs";

const ui = UI_DICTIONARIES satisfies Record<Locale, Record<string, string>>;

export type UIKey = keyof (typeof ui)[typeof DEFAULT_LOCALE];

export function t(locale: Locale, key: UIKey) {
  return ui[locale][key] ?? ui[DEFAULT_LOCALE][key];
}
