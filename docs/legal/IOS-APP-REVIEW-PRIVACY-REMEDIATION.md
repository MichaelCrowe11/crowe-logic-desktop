# iOS App Review privacy remediation

Context for App Review rejection:

- Review date: **2026-09-18**
- Submission ID: **305416aa-942e-4b65-beab-453d27a69c2b**
- Rejected build: **1.0 (2505)** / app version **0.25.5**
- Review device: **iPhone 17 Pro Max**
- Guidelines: **5.1.1(i)** and **5.1.2(i)**

This document separates what was implemented in this repository from what still
requires an operator, backend owner, or App Store Connect action.

## What this repository now implements

- A mobile-only, fail-closed AI sharing gate before supported AI sends.
- An in-app disclosure that lists verified recipients, data categories, purpose,
  and a **Not now** / **Allow** choice.
- Settings controls to review the disclosure, see current status, and revoke the
  permission later.
- Revocation that blocks future sends and aborts in-flight mobile runs where the
  app can stop them.
- Removal of automatic signed-in email injection from mobile AI prompts.
- Blocking of mobile model routes whose recipients are not verified in this
  repository's disclosure set.
- Regression tests that assert no network payload leaves the app before consent.

## Verified mobile data-flow evidence

| Feature | Data involved | Transmission boundary | Verified recipient disclosure in app | Evidence in this repo |
| --- | --- | --- | --- | --- |
| Chat / agent turn | User message, conversation context, selected model, tool definitions and results, paired-machine output or file content pulled into the turn | `mobile/src/mobile-bridge.js` → `POST /api/gateway/chat` | Crowe Logic, Microsoft Azure, Cloudflare for supported CroweLM routes | `mobile/src/mobile-bridge.js`, `mobile/README.md`, `docs/HARNESS-ARCHITECTURE.md`, `docs/ROADMAP.md` |
| Vision / camera / shared photo | Photo, note/caption, same turn context as above | Same gateway chat path, routed to CroweLM Vision | Same verified CroweLM recipient set | `mobile/src/mobile-bridge.js`, `mobile/src/mobile-ui.js`, `mobile/src/share-inbox.js`, `mobile/README.md`, `mobile/ios/App/CroweShare/ShareViewController.swift` |
| Remote reply voice | Up to 1,500 characters of assistant reply text plus selected remote voice | `mobile/src/speak.js` → `/api/gateway/speech/voices` and `/api/gateway/speech` | Same verified CroweLM recipient set | `mobile/src/speak.js` |
| Siri / App Intents ask flow | Intent text the user dictated or supplied | Seeds the same chat send path, therefore same consent gate | Same verified CroweLM recipient set | `mobile/ios/App/App/CroweIntents.swift`, `mobile/src/mobile-ui.js`, `mobile/src/mobile-bridge.js` |
| Share extension text | Shared text/URL becomes a draft until the user sends it | No network until the user sends from the app | No AI send without the same disclosure and consent | `mobile/src/share-inbox.js`, `mobile/src/mobile-ui.js` |
| On-device dictation | Spoken input for transcription | Native iOS speech recognition path, not the Crowe gateway path | Not part of the remote AI sharing consent | `mobile/ios/App/App/CroweSpeech.swift` |

## Current mobile disclosure scope

The implemented disclosure covers these supported routes:

- `crowelm` chat and agent routes
- `crowelm-vision` photo/vision routes
- remote reply voice routes served through the Crowe gateway speech endpoints

If a mobile route would use a recipient that is not verified by this repository,
the app blocks that route and tells the user the disclosure needs an update.
That is intentional: do not silently inherit consent for unknown recipients.

## Proposed App Store Connect App Privacy answers

These answers still require owner review before submission.

### Data not used for tracking

No tracking implementation was verified in this repository for the iOS app.
Marking anything as tracking would require separate evidence.

### Data types to review for collection/disclosure

| App Privacy category | Proposed answer | Why / evidence | Owner confirmation needed |
| --- | --- | --- | --- |
| Contact Info → Email Address | **Collected** for app functionality / account management | Crowe ID sign-in payloads include the signed-in email; the mobile bridge reads the current user email from the token/account state | Confirm final App Store wording and any server-side retention/deletion wording |
| User Content → Photos or Videos | **Collected** when the user chooses Camera / Vision / share-photo flows and allows AI sharing | Vision path converts photos to `image_url` content for the gateway chat turn | Confirm whether App Store should classify this as "Photos or Videos" only or also "Other User Content" |
| User Content → Other User Content | **Collected** for chat text, shared text, captions/notes, and conversation context used to answer the turn | Mobile chat and vision sends include message text and conversation context | Confirm final wording |
| Audio Data | **Not collected by the implemented remote voice feature** for user audio; the remote speech path sends assistant reply text, not microphone audio | `mobile/src/speak.js` sends text to the speech gateway; `CroweSpeech.swift` handles dictation locally | Confirm whether any server-side speech features outside this repo exist |
| Diagnostics | **Review before answering** | This repository verifies desktop telemetry/crash submission, but did not verify a separate mobile telemetry uploader | Confirm whether App Store Connect should list mobile diagnostics based on live backend/build configuration |
| Identifiers | **Review before answering** | The current mobile consent/account binding uses Crowe ID account state; App Privacy treatment depends on the live backend classification | Confirm with live backend owner/legal review |

Do **not** add provider retention, training, or "same/equal protection" claims to
App Store Connect unless they are confirmed for the live gateway contracts.

## Reviewer test steps

Use these exact steps in App Review Information after building a new iOS binary:

1. Install the new build and open **Crowe Logic**.
2. Sign in with a test **Crowe ID**.
3. In **Chat**, type a message and tap **Send**.
4. Verify the app shows an **Allow AI data sharing?** disclosure before any
   response begins.
5. Tap **Not now** and confirm the message remains in the composer and no reply
   is generated.
6. Tap **Send** again, choose **Allow**, and verify the message is then sent and
   answered.
7. Open **Settings** and verify the **AI data sharing** section shows the current
   status and offers **Review disclosure** and **Stop sharing**.
8. Tap **Stop sharing**, return to **Chat**, and verify another send is blocked
   until the user allows it again.
9. Open **Camera**, choose or take a photo, and verify the same disclosure gates
   the first supported vision send.
10. Optionally tap the speaker on an assistant reply after selecting a remote
    reply voice, and verify the same consent status governs that send as well.

## Ready-to-adapt App Review reply

> Hello App Review,
>
> Thank you for the rejection details. We updated Crowe Logic to address
> Guidelines 5.1.1(i) and 5.1.2(i).
>
> In the iOS app, before any supported mobile AI request is sent, the app now
> shows an in-app disclosure that identifies:
>
> - what data can be sent,
> - which verified recipients receive it,
> - why it is sent, and
> - where the user can review and revoke that permission later.
>
> The user must tap **Allow** before the app sends the supported request.
> Tapping **Not now** keeps the draft in place and prevents the send. The
> Settings screen now also shows the current AI data-sharing status and allows
> the user to review the disclosure or stop sharing.
>
> We also updated the repository privacy-policy draft and our submission
> materials so the App Store Connect privacy answers and reviewer instructions
> can be updated consistently for the new build.
>
> Review steps:
> 1. Sign in with Crowe ID.
> 2. Go to Chat and send a message.
> 3. Verify the disclosure appears before the first supported AI send.
> 4. Tap Not now to keep the draft without sending, or Allow to continue.
> 5. Open Settings to review or revoke the permission.
>
> Thank you.

Adapt that reply only with facts you have independently confirmed outside this
repository, such as the final privacy-policy URL or server-side processor terms.

## Manual operator checklist before resubmission

- [ ] Confirm the final published privacy-policy URL and update App Store Connect.
- [ ] Review the proposed App Privacy answers above against the live backend,
      legal terms, and any server-side logging/retention behavior.
- [ ] Confirm the live Crowe gateway's processor list, retention, training, and
      "same or equal protection" commitments before making those claims publicly.
- [ ] Build a new iOS binary from the current mobile version source. The current
      repository version is `mobile/package.json` **0.25.7**, which maps to build
      **2507** if `mobile/scripts/sync-version.js` is used.
- [ ] Archive/sign/export/upload the new build with Xcode/App Store Connect.
- [ ] Select the new build in App Store Connect. Do **not** reuse rejected build
      `2505`.
- [ ] Paste the reviewer instructions and the adapted reply into App Review
      Information / the review response.
- [ ] Resubmit for review.

## External blockers and unverified items

These are not solved by a client-only repository change and still need owner or
backend confirmation:

- The live gateway's upstream processor list for any non-CroweLM mobile routes.
- Gateway-side retention/deletion/training terms.
- The contractual basis for any "same or equal protection" statement.
- Final App Store Connect App Privacy answers.
- Actual build/upload/resubmission work in App Store Connect.
- Hosted CI is currently blocked by an external GitHub Actions `action_required`
  gate rather than a code failure.
