# Crowe Logic phone mirror, local build 0.26.9

Built and installed on October 6, 2026, preserving the 0.26.8 phone source at commit `119984b`.

Home → Shared terminal and drafts opens the paired desktop's managed sessions. Terminal is initially a viewer; Take control requires Execute mode on both devices. Draft and Review edit an open Crowe Logic Control+G draft, with revision conflict handling and a separate return operation. Returning never submits the CLI prompt.

The matching desktop source is `/Users/crowelogic/Projects/crowe-logic-desktop-cli-editor`. Its `docs/PHONE-MIRROR-PLAN.md` describes the implementation, remaining physical-device checks and backend roadmap. The installed app is `~/.local/share/crowe-editors/Crowe Logic.app`. Start Phone companion in desktop Settings and pair the phone on the same Tailscale network. The app and Mac must remain running and awake.

This worktree changes only the mobile mirror assets, its native HTTP adapter, a narrow renderer entry point, mobile navigation, asset packaging, build version and relevant shell checks. The installed build is local development software, not an App Store submission.

Verification receipts: `~/.local/share/crowe-editors/phone-mirror-verification-2026-10-06/`. Mobile shell checks: 42/42. Companion pairing, native HTTP over Tailscale, live physical-phone terminal rendering and a two-line shared-draft return passed. Save and return restored `One\nTwo` to the same CLI prompt without submission; the test text was then cleared. Physical phone lock/unlock and controller handoff remain untested. The final rebuild disables iOS draft autocorrection and capitalization and labels empty drafts correctly. Home now waits for the saved pairing configuration at cold start, preventing a stale Not paired card. Pairing persisted across the app update.
