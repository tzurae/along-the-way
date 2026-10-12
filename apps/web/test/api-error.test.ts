import { describe, expect, it } from "vitest";
import { zhTW } from "../src/locales/zh-TW";
import { localizedApiErrorMessage } from "../src/api-error";

describe("localized API errors", () => {
  it("never exposes server-provided English validation or conflict details", () => {
    expect(localizedApiErrorMessage(
      zhTW.errors,
      "validation_error",
      "tripId must be a UUID",
    )).toBe("要求內容有誤。");
    expect(localizedApiErrorMessage(
      zhTW.errors,
      "conflict",
      "The trip changed while planning; plan again",
      "request-reference",
      8,
    )).toBe("資料已變更，無法完成操作。 目前版本：8。 參考編號：request-reference");
  });

  it("uses only the local catalog for known and unknown server codes", () => {
    expect(localizedApiErrorMessage(zhTW.errors, "used_magic_link", "This sign-in link was already used"))
      .toBe("這個登入連結已使用。");
    expect(localizedApiErrorMessage(zhTW.errors, "new_server_code", "Sensitive server detail"))
      .toBe("無法完成要求。");
  });
});
