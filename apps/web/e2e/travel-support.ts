import { expect, type Locator } from "@playwright/test";

async function chooseAirport(group: Locator, index: number, code: "TPE" | "KIX") {
  const input = group.getByLabel("機場代碼或名稱").nth(index);
  await input.fill(code);
  await group.page().getByRole("option", { name: new RegExp(`^${code}\\b`) }).click();
  await expect(input).toHaveValue(new RegExp(`^${code} ·`));
}

export async function fillTripFlights(dialog: Locator, startDate: string, endDate: string) {
  const submit = dialog.getByRole("button", { name: "建立旅程", exact: true });
  const outbound = dialog.getByRole("group", { name: "去程", exact: true });
  const returning = dialog.getByRole("group", { name: "回程", exact: true });
  await expect(submit).toBeDisabled();

  await chooseAirport(outbound, 0, "TPE");
  await chooseAirport(outbound, 1, "KIX");
  await expect(returning.getByLabel("機場代碼或名稱").nth(0)).toHaveValue(/^KIX ·/);
  await expect(returning.getByLabel("機場代碼或名稱").nth(1)).toHaveValue(/^TPE ·/);

  await outbound.getByLabel("起飛時間（當地）").fill(`${startDate}T05:00`);
  await outbound.getByLabel("抵達時間（當地）").fill(`${startDate}T09:00`);
  await expect(submit).toBeDisabled();
  for (const [group, serviceNumber] of [
    [outbound, "FIXTURE-OUT"],
    [returning, "FIXTURE-RETURN"],
  ] as const) {
    await group.getByText("航班資訊（選填）", { exact: true }).click();
    await group.getByLabel("航班號碼（選填）", { exact: true }).fill(serviceNumber);
  }
  await returning.getByLabel("起飛時間（當地）").fill(`${endDate}T18:00`);
  await returning.getByLabel("抵達時間（當地）").fill(`${endDate}T21:00`);
  await expect(submit).toBeEnabled();
}
