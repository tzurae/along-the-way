import { createContext, useContext, type ReactNode } from "react";

import { zhTW } from "./locales/zh-TW";

/** Every language provides the same messages as Traditional Chinese, the first one. */
export type Messages = typeof zhTW;
export type Locale = "zh-TW";

interface I18n {
  /** BCP 47 tag for `Intl` dates and numbers and the page's `lang`. */
  locale: Locale;
  t: Messages;
}

// One value per language, so consumers re-render only when the language changes.
const languages: Record<Locale, I18n> = {
  "zh-TW": { locale: "zh-TW", t: zhTW },
};

const I18nContext = createContext<I18n>(languages["zh-TW"]);

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <I18nContext.Provider value={languages[locale]}>{children}</I18nContext.Provider>;
}

/** The current language's messages (`t`) and its locale tag. */
export function useI18n() {
  return useContext(I18nContext);
}
