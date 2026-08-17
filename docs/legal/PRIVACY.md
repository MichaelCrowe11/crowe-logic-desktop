# Crowe Logic Desktop privacy policy

> **Draft.** This document describes what the app actually does as of 0.24.0,
> verified against the source (`main.js`). It has not been reviewed by counsel
> and the contact addresses below must be confirmed before it is published or
> linked from the download page.

Effective date: not yet in effect. Applies to the Crowe Logic desktop app
(`com.crowelogic.desktop`) and its mobile companion.

## The short version

Your conversations, files, and keys stay on your machine. The app talks to
Crowe Logic servers for three things: signing in, routing model requests you
initiate, and (unless you turn it off) minimal usage and crash telemetry that
contains no message content, file paths, or tokens.

## What stays on your device

- **Conversations and sessions.** Chat history is stored as local JSON under
  the app's data directory. Nothing is synced to a server.
- **Files and the workspace.** The app reads and edits files only on your
  machine, through an approve/reject review unless you enable auto-approve.
- **Credentials.** Sign-in tokens and any provider API keys you add are
  encrypted with the operating system's credential store (Electron
  `safeStorage`) and written only to the app's data directory.
- **Crash dumps.** Always written locally so you can inspect them, whether or
  not telemetry is on.

## What leaves your device

- **Sign-in.** Authentication uses Crowe ID (`id.crowelogic.com`) over OAuth2
  with PKCE. The app receives and stores tokens; it never sees your password.
- **Model requests.** When you send a message, the conversation content needed
  to answer it is sent to the Crowe Logic gateway (`api.crowelogic.com` by
  default, configurable in Settings) and routed to the model you selected.
  Requests are processed to produce the response and for abuse prevention.
- **Telemetry (opt-out).** With telemetry on, the app sends minimal usage
  events (app launch, agent turn counts, unhandled main-process exceptions)
  and crash reports. Each carries only app version, platform, architecture,
  release channel, and selected model name. No message content, no file paths,
  no tokens. Turn it off in Settings and nothing is submitted; crash dumps
  then exist only locally.
- **Update checks.** Installed builds check the Crowe Logic release channel
  for new versions. Downloads happen only with your consent.

## Third parties

Model routing may place your request with the model provider you selected.
Release downloads and update feeds are served through Cloudflare. The app does
not embed third-party analytics or advertising SDKs.

## Data retention and deletion

Local data (sessions, journal, artifacts, credentials) lives in the app's data
directory and is yours to delete; removing the app's data directory removes
it. For gateway-side data tied to your Crowe ID account, contact us at the
address below.

## Children

The app is not directed at children under 13 and should not be used by them.

## Changes

Material changes to this policy will be noted in release notes and on the
download page before they take effect.

## Contact

privacy@crowelogic.com (to be confirmed before publication).
