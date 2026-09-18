# Crowe Logic privacy policy

> **Draft.** This document is grounded in this repository's current code. It is not
> legal advice, it has not been reviewed by counsel, and it deliberately avoids
> promises about gateway-side retention, model training, or "equal protection"
> that are not verifiable from this repository alone.

Effective date: not yet in effect.

This policy covers the Crowe Logic desktop app (`com.crowelogic.desktop`) and the
Crowe Logic mobile app in `mobile/`.

## What this app stores on your device

- **Conversations and session history.** The app stores chat history and related
  session state locally so you can reopen prior work.
- **Grow-log records, reminders, and drafts.** Cultivation records, local
  reminders, unsent drafts, and photos waiting to be sent stay in app storage on
  the device until you remove them or send them.
- **Credentials.**
  - On the desktop app, Crowe ID tokens and provider keys are stored with the
    operating system credential store when Electron credential encryption is
    available.
  - On the mobile app, the config/auth record is moved into the iOS Keychain by
    the native vault plugin when that plugin is available. Other mobile settings
    and records use app-private storage. Provider keys on the phone are stored
    in app-private storage, not in the desktop hardware-backed vault.
- **Crash dumps.** Desktop crash dumps are written locally so they can be
  inspected even if network submission is turned off.

## What can leave your device

### 1. Sign-in

Crowe Logic uses Crowe ID (`id.crowelogic.com`) for sign-in. The app uses an
OAuth flow with PKCE, receives tokens, and stores those tokens locally as
described above. The app does not ask for your Crowe ID password directly.

### 2. Mobile AI features that require prior permission

On the mobile app, supported AI features are blocked until you tap **Allow** on
an in-app disclosure for the current Crowe ID account and configured Crowe Logic
gateway. Tapping **Not now** or dismissing the disclosure prevents the send.
You can review or revoke that choice later in Settings.

If you allow AI sharing, the mobile app can send the following data to the
Crowe Logic gateway when you use supported AI features:

- your message text and the conversation context needed to answer it
- the selected model and feature metadata
- grow-log context, tool definitions, and tool results that a turn includes
- file contents or machine output that a tool reads and feeds back into the
  same turn
- photos you take, choose, or share into the app, plus any caption or lot note
  that goes with them, when you use CroweLM Vision
- up to 1,500 characters of assistant reply text and the remote reply voice you
  chose, when you ask the app to read a reply aloud through the remote voice
  service

The mobile app does **not** infer this permission from sign-in, onboarding,
Terms, camera access, microphone access, or file picking.

The mobile app also keeps these items local unless and until you send them:

- the phone's own reply voice
- the iOS dictation path used by the app target
- grow-log rows, reminders, and unsent drafts

If a mobile route would use a recipient that is **not** verified in this
repository's disclosure set, the app blocks that route instead of silently
sending data to an undisclosed recipient.

### 3. Desktop AI and update traffic

- **Desktop model requests.** When you send a message from the desktop app, the
  conversation content needed to answer it is sent to the configured Crowe Logic
  gateway (`api.crowelogic.com` by default).
- **Desktop updates.** Installed desktop builds check Crowe Logic release feeds
  for updates. The desktop app downloads an update only when you choose to do
  so.
- **Desktop telemetry and crash submission (optional).** Desktop builds can send
  minimal telemetry and crash reports to Crowe Logic when telemetry is enabled.
  The code in this repository limits that telemetry to app/runtime metadata such
  as app version, platform, architecture, release channel, selected model name,
  token counts, cost, and timestamps. It is not intended to include chat
  message text, file paths, or access tokens.

## Who can receive the data

For the mobile AI routes that this repository currently allows after consent,
the disclosed recipients are:

- **Crowe Logic, Inc.** — operates Crowe ID and the Crowe Logic gateway.
- **Microsoft Azure** — repository documentation describes CroweLM deployments
  running on Crowe Logic-managed Azure infrastructure.
- **Cloudflare** — repository documentation describes CroweLM routing and
  related infrastructure running on Crowe Logic-managed Cloudflare services.

This repository does **not** verify the live contractual terms, retention,
training, or equal-protection commitments for those services. Do not publish
stronger claims until those terms are confirmed outside the repository.

## How the app uses the data

The app uses data for the following purposes:

- authenticate your Crowe ID session
- generate chat, agent, and vision responses you ask for
- read a reply aloud when you choose a remote reply voice
- keep local session history, grow-log records, reminders, and drafts available
  on your device
- deliver desktop updates you choose to download
- operate optional desktop telemetry and crash reporting
- prevent abuse, route requests, and return the response you asked for through
  the Crowe Logic gateway

## Your choices

- On mobile, you can allow or decline AI sharing before the first supported AI
  send.
- On mobile, you can review the disclosure in Settings and revoke permission
  later. Revocation stops future sends where the app can stop them, but it does
  not recall data already transmitted.
- You can delete local app data by removing the app's stored data from your
  device.
- Crowe ID account deletion and any gateway-side deletion request depend on
  Crowe Logic's live account systems and support process, not on local deletion
  alone.
- Desktop telemetry can be turned off in Settings.

## Retention and deletion

This repository verifies local storage locations and revocation controls, but it
does not contain a complete gateway-side retention schedule. Local data remains
on your device until you delete it or remove the app data. For gateway-side
retention, deletion, and processor commitments tied to your Crowe ID account,
Crowe Logic must confirm the live policy and support channel before this draft
is published externally.

## Children

The app is not directed to children under 13.

## Changes

Material privacy changes should be reflected in the in-app disclosure,
repository policy, and release notes before they take effect.

## Contact

Privacy/support contact information must be confirmed before publication.
