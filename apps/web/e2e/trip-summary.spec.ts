import { expect, test } from "@playwright/test";

test("a traveler can see the database-backed trip summary", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "一起走的香港四日" }),
  ).toBeVisible();
  await expect(page.getByText("2026/8/28－2026/8/31")).toBeVisible();
  await expect(page.getByText("2 位旅伴・4 天")).toBeVisible();
  await expect(page.getByText("一起選定第二天晚餐")).toBeVisible();
});
