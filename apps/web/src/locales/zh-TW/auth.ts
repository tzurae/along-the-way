export const auth = {
  brand: "ALONG THE WAY",
  heading: "一起規劃私人旅程",
  intro: "請輸入你在旅程中使用的電子郵件。我們會寄一封 15 分鐘內有效的登入信，不需要密碼。",
  privateSpace: "這是受邀成員的私人空間，不開放公開註冊。",
  inviteHeading: "加入私人旅程",
  inviteIntro: "我們會把 15 分鐘內有效的一次性登入連結寄到受邀的信箱，不需要再次輸入電子郵件。",
  email: "電子郵件",
  requestLink: "寄送登入連結",
  requestingLink: "正在寄出登入連結…",
  requestInviteLink: "寄送登入連結到受邀信箱",
  sentHeading: "查看你的電子郵件",
  sentMessage: (email: string) =>
    `如果 ${email} 可以登入，一次性登入連結已寄出。請查看收件匣與垃圾郵件；連結 15 分鐘內有效。`,
  inviteSentMessage: "如果這個邀請仍然有效，登入連結已寄到受邀的信箱。",
  invitedOnly:
    "只有已受邀的成員會收到登入信。第一次使用的人，請先請旅程建立者從「成員」寄邀請，再從邀請信裡的連結加入。",
  editEmail: "電子郵件填錯了？修改",
  resendAfter: (seconds: number) => `${seconds} 秒後可重新寄送`,
  resend: "重新寄送",
  retrySignIn: "重試登入",
  emailRequired: "請輸入電子郵件。",
  emailInvalid: "請輸入有效的電子郵件。",
  progress: {
    restoring: "正在確認登入狀態…",
    "consuming-link": "正在驗證登入連結…",
    "loading-trips": "登入成功，正在載入你的旅程…",
  },
} as const;
