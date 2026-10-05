import { expect, type Locator } from "@playwright/test";

export async function fillTripFlights(dialog: Locator, startDate: string, endDate: string) {
  const submit = dialog.getByRole("button", { name: "建立旅程", exact: true });
  await expect(submit).toBeDisabled();
  for (const [label, number, date, departure, arrival] of [
    ["去程", "FIXTURE-OUT", startDate, "05:00", "06:00"],
    ["回程", "FIXTURE-RETURN", endDate, "22:00", "23:00"],
  ]) {
    const group = dialog.getByRole("group", { name: label, exact: true });
    await group.getByLabel("航班號碼", { exact: true }).fill(number!);
    await group.getByLabel("出發機場", { exact: true }).fill(label === "去程" ? "Fixture home airport" : "Fixture destination airport");
    await group.getByLabel("抵達機場", { exact: true }).fill(label === "去程" ? "Fixture destination airport" : "Fixture home airport");
    await group.getByLabel("出發機場 IANA 時區").fill("Asia/Tokyo");
    await group.getByLabel("抵達機場 IANA 時區").fill("Asia/Tokyo");
    await group.getByLabel("起飛時間（當地）").fill(`${date}T${departure}`);
    await group.getByLabel("抵達時間（當地）").fill(`${date}T${arrival}`);
    if (label === "去程") await expect(submit).toBeDisabled();
  }
  await expect(submit).toBeEnabled();
}
