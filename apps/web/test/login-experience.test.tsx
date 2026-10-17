// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { LoginExperience } from "../src/LoginExperience";

function renderLogin(overrides: Partial<React.ComponentProps<typeof LoginExperience>> = {}) {
  const requestLink = overrides.requestLink ?? vi.fn(async () => {});
  const requestInviteLink = overrides.requestInviteLink ?? vi.fn(async () => {});
  render(
    <LoginExperience
      initialError={overrides.initialError}
      inviteToken={overrides.inviteToken ?? null}
      requestLink={requestLink}
      requestInviteLink={requestInviteLink}
      verifyCode={overrides.verifyCode ?? vi.fn(async () => {})}
      retryConsume={overrides.retryConsume}
      describeError={overrides.describeError ?? (() => "無法索取登入連結。")}
    />,
  );
  return { requestLink, requestInviteLink };
}

function submitEmail(email = "traveler@example.test") {
  fireEvent.change(screen.getByRole("textbox", { name: "電子郵件" }), { target: { value: email } });
  fireEvent.submit(screen.getByRole("button", { name: "寄送登入連結" }).closest("form")!);
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("offers an invite-only CTA without asking for an email address", async () => {
  const requestInviteLink = vi.fn(async () => {});
  renderLogin({ requestInviteLink, inviteToken: "family-invite" });

  expect(screen.queryByRole("textbox", { name: "電子郵件" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "寄送登入連結到受邀信箱" }));

  await waitFor(() => expect(requestInviteLink).toHaveBeenCalledWith("family-invite"));
  expect(screen.getByRole("status")).toHaveTextContent(
    "如果這個邀請仍然有效，登入連結已寄到受邀的信箱。",
  );
  expect(screen.queryByText(/family-invite|@/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "60 秒後可重新寄送" })).toBeDisabled();
});

it("ignores an invite-link response after the tab changes to a different invitation", async () => {
  let resolveFirst!: () => void;
  const requestInviteLink = vi.fn(
    (token: string) => token === "first-invite"
      ? new Promise<void>((resolve) => { resolveFirst = resolve; })
      : Promise.resolve(),
  );
  const describeError = () => "無法索取登入連結。";
  const rendered = render(
    <LoginExperience
      inviteToken="first-invite"
      requestLink={vi.fn(async () => {})}
      requestInviteLink={requestInviteLink}
      verifyCode={vi.fn(async () => {})}
      describeError={describeError}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "寄送登入連結到受邀信箱" }));
  await waitFor(() => expect(requestInviteLink).toHaveBeenCalledWith("first-invite"));

  rendered.rerender(
    <LoginExperience
      inviteToken="second-invite"
      requestLink={vi.fn(async () => {})}
      requestInviteLink={requestInviteLink}
      describeError={describeError}
      verifyCode={vi.fn(async () => {})}
    />,
  );
  expect(screen.getByRole("button", { name: "寄送登入連結到受邀信箱" })).toBeEnabled();

  await act(async () => resolveFirst());
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "寄送登入連結到受邀信箱" })).toBeEnabled();
});

it("keeps the submitted address stable and disables editing while the request is in flight", async () => {
  let resolveRequest!: () => void;
  const requestLink = vi.fn(() => new Promise<void>((resolve) => { resolveRequest = resolve; }));
  renderLogin({ requestLink });

  submitEmail("original@example.test");

  const input = screen.getByRole("textbox", { name: "電子郵件" });
  expect(await screen.findByRole("button", { name: "正在寄出登入連結…" })).toBeDisabled();
  expect(input).toBeDisabled();
  fireEvent.change(input, { target: { value: "changed@example.test" } });
  await act(async () => resolveRequest());
  expect(await screen.findByText(/如果 original@example\.test 可以登入/)).toBeInTheDocument();
});

it("names the submitted address and focuses the sent-state heading", async () => {
  renderLogin();

  submitEmail("owner@example.test");

  const heading = await screen.findByRole("heading", { name: "查看你的電子郵件" });
  expect(screen.getByText(/如果 owner@example\.test 可以登入/)).toBeInTheDocument();
  expect(heading).toHaveFocus();
});

it("returns to the editable form without discarding the email", async () => {
  renderLogin();
  submitEmail("owner@example.test");
  await screen.findByRole("heading", { name: "查看你的電子郵件" });

  fireEvent.click(screen.getByRole("button", { name: "電子郵件填錯了？修改" }));

  expect(screen.getByRole("textbox", { name: "電子郵件" })).toHaveValue("owner@example.test");
  await waitFor(() => expect(screen.getByRole("textbox", { name: "電子郵件" })).toHaveFocus());
});

it("holds resend for 60 seconds, then enables it", async () => {
  vi.useFakeTimers();
  renderLogin();
  submitEmail();
  await act(async () => {});

  expect(screen.getByRole("button", { name: "60 秒後可重新寄送" })).toBeDisabled();
  act(() => vi.advanceTimersByTime(59_000));
  expect(screen.getByRole("button", { name: "1 秒後可重新寄送" })).toBeDisabled();
  act(() => vi.advanceTimersByTime(1_000));
  expect(screen.getByRole("button", { name: "重新寄送" })).toBeEnabled();
});

it("blocks the same edited address during cooldown but sends a different address", async () => {
  vi.useFakeTimers();
  const requestLink = vi.fn(async () => {});
  renderLogin({ requestLink });
  submitEmail("owner@example.test");
  await act(async () => {});

  fireEvent.click(screen.getByRole("button", { name: "電子郵件填錯了？修改" }));

  const blocked = screen.getByRole("button", { name: "60 秒後可重新寄送" });
  expect(blocked).toBeDisabled();
  fireEvent.submit(blocked.closest("form")!);
  expect(requestLink).toHaveBeenCalledTimes(1);

  fireEvent.change(screen.getByRole("textbox", { name: "電子郵件" }), {
    target: { value: "companion@example.test" },
  });
  const submit = screen.getByRole("button", { name: "寄送登入連結" });
  expect(submit).toBeEnabled();
  fireEvent.submit(submit.closest("form")!);
  await act(async () => {});
  expect(requestLink).toHaveBeenNthCalledWith(2, "companion@example.test");
});

it("announces a rejected request and re-enables submission", async () => {
  const failure = new Error("network");
  renderLogin({
    requestLink: vi.fn(async () => { throw failure; }),
    describeError: (error) => error === failure ? "目前無法寄送，請稍後再試。" : "未知錯誤",
  });

  submitEmail();

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("目前無法寄送，請稍後再試。");
  expect(screen.getByRole("button", { name: "寄送登入連結" })).toBeEnabled();
});

it("renders an initial localized error on mount", () => {
  renderLogin({ initialError: "這個登入連結已使用。請寄一封新的登入信。" });

  expect(screen.getByRole("alert")).toHaveTextContent("這個登入連結已使用。請寄一封新的登入信。");
});

it("SEC-01 submits the emailed code with the original address and reports failures", async () => {
  const verifyCode = vi.fn(async () => { throw new Error("wrong code"); });
  renderLogin({ verifyCode, describeError: () => "登入碼無效，請再試一次。" });
  submitEmail("owner@example.test");
  await screen.findByRole("heading", { name: "查看你的電子郵件" });
  const input = screen.getByRole("textbox", { name: "6 位數登入碼" });
  expect(input).toHaveAttribute("autocomplete", "one-time-code");
  fireEvent.change(input, { target: { value: "012345" } });
  fireEvent.submit(screen.getByRole("button", { name: "使用登入碼登入" }).closest("form")!);
  await waitFor(() => expect(verifyCode).toHaveBeenCalledWith("owner@example.test", "012345"));
  expect(await screen.findByRole("alert")).toHaveTextContent("登入碼無效，請再試一次。");
  expect(screen.getByRole("button", { name: "使用登入碼登入" })).toBeEnabled();
});

it("SEC-01 lets an invite recipient enter their email and code without exposing it beforehand", async () => {
  const verifyCode = vi.fn(async () => {});
  renderLogin({ verifyCode, inviteToken: "invitation" });
  fireEvent.click(screen.getByRole("button", { name: "寄送登入連結到受邀信箱" }));
  await screen.findByRole("heading", { name: "查看你的電子郵件" });
  fireEvent.change(screen.getByRole("textbox", { name: "電子郵件" }), { target: { value: "invited@example.test" } });
  fireEvent.change(screen.getByRole("textbox", { name: "6 位數登入碼" }), { target: { value: "123456" } });
  fireEvent.submit(screen.getByRole("button", { name: "使用登入碼登入" }).closest("form")!);
  await waitFor(() => expect(verifyCode).toHaveBeenCalledWith("invited@example.test", "123456"));
});
