# Product Hunt readiness

Checked 2026-09-20 against desktop release 0.24.15, commit 0198f15, plus the local changes listed below.

## Verdict

Hold the public launch until the remaining gates are closed. Local fixes are verified, not released. No website deployment, installer publication, account creation, payment or subscription change was performed.

## Fixed locally

- Added the missing desktop Settings > Privacy switch for usage events and crash reports.
- Saving the switch updates Electron's crash-upload setting immediately and persists the choice.
- Removed raw exception messages from desktop usage events. Native crash dumps may still contain sensitive process memory; the notice now says this explicitly.
- Added privacy, terms and support links to onboarding, desktop Settings and the download-page template.
- Added a desktop-specific section to the website privacy page, preserving the existing iPhone changes in that working tree. It distinguishes shipped 0.24.15 behavior from the new switch and explains how existing users can opt out.
- Fixed the OAuth callback page claiming success before token exchange and credential storage succeeded. The exchange has a deadline and unsuccessful completion shows a failure in both the browser and app.
- Added sign-in and real Electron privacy regression tests to npm test.

Website source: /Users/crowelogic/crowe-logic-web/public/foundry/legal.html.
Desktop source: /Users/crowelogic/crowe-logic-desktop-release.

## Verified

| Check | Result and limits |
| --- | --- |
| Public stable distribution | macOS, Windows and Linux feeds advertise 0.24.15; artifacts resolve with ranges and matching declared sizes; checksum manifest covers the release |
| Public Mac arm64 ZIP | Downloaded and SHA-256 verified; deep strict codesign verification passed; Gatekeeper accepted Notarized Developer ID |
| Packaged Mac launch | Downloaded 0.24.15 app launched on a throwaway profile; bundled plugin utility process survived its handshake and exited with the app; live profile did not change |
| Developers build preflight | Three local feeds and seven artifacts passed SHA-512 and size checks; these are existing 0.24.15 artifacts, not builds of the new changes |
| Harness | 105 tests passed after changes |
| Electron security | 140 checks passed after sign-in changes |
| Renderer panels | 106/106 passed after changes, using the local development server and real Electron DOM |
| Desktop privacy | Fresh isolated profile; onboarding notice; real renderer/preload/IPC; toggle persistence; immediate native crash opt-out and re-enable; raw exception text excluded |
| Sign-in regression | Success, rejected exchange, network error and storage failure; actual loopback callbacks with fake identity exchange; PKCE checked, invalid state rejected, repeat click joins the attempt |
| Other targeted suites | First run, plan, packaging, brand copy, preview drift and release worker passed; release worker 51/51 plus legal-link assertions |
| Dependencies | npm audit and production-only audit reported zero vulnerabilities during the initial audit |
| Website privacy UI | Served locally and exercised with Playwright Chromium at 1280 and 390 pixels; desktop section visible and Terms navigation works |
| Crowe ID discovery | Public OpenID configuration reachable; this is not proof of a successful member login |
| Billing catalog | Public catalog reachable; Personal and Pro amounts match the approved prices; no purchase was created |

Test network responses are fake where identified. These results do not prove live account provisioning, model inference, payment webhooks or entitlement refresh. The full npm test chain was not run; the targeted suites above were run.

## Remaining launch gates

1. **Fresh customer journey:** sign in with a fresh test Crowe ID, choose an empty project, complete a real first task, restart and confirm session recovery. No test identity was supplied or created in this work.
2. **Billing journey:** use a designated Stripe test-mode environment/account to prove checkout, webhook provisioning, desktop entitlement refresh and cancellation. Current plan tests do not exercise production payment services.
3. **Pricing mismatch, measured 2026-09-20 02:5x MST:** the landing page sells Personal $29, Pro $99 and Max $199 through the control plane (api.crowelogic.com, POST /api/billing/checkout/self, Stripe prices from STRIPE_PRICE_PERSONAL, STRIPE_PRICE_PRO and STRIPE_PRICE_MAX on the crowe-foundry container app). The desktop app sells through the crowe-checkout Worker ladder (BYOK 19, Personal 29, Pro 99, Team 199, Scale 249, Studio 299, Business 499, Enterprise), which has no Max rung and charges Pro through a different Stripe price object (price_1TcZX6... in the Worker, price_1U1Sxk... in the control plane). The control plane's public display price for Pro is $149 with $1,524 annual (migration 009_pro_price_149) while the landing page and the Worker say $99; the approved prices on 2026-09-12 were Personal 29, Pro 99 with 1,020 annual, Max 199 with 2,028 annual, Team 49 per seat. Before launch: read the amounts behind the control plane's Pro and Max price ids, add a Max rung to the Worker on STRIPE_PRICE_MAX, and set the control plane's Pro display price to the approved figure or change the page. Never invent a price.
4. **Release and deployment approval:** build a new version containing these fixes, then publish the approved stable and Developers artifacts and deploy the website/download-worker changes. Do not overwrite 0.24.15 artifacts. The live Developers channel still serves 0.24.14.
5. **Public policy review:** desktop disclosure is corrected locally, but existing provider-routing and retention statements elsewhere on the legal page still need confirmation against the running services. The local legal draft remains marked as a draft; this work is not counsel sign-off.
6. **Platform claims:** packaged launch was tested on this Mac, not on fresh Windows or Linux machines. Limit launch claims or obtain those checks.
7. **Launch presentation:** the public page uses older desktop screenshots and a long film. Confirm a short task-focused demo, current screenshots and the final Product Hunt copy before posting.

## Evidence

- proof-product-hunt-audit/packaged.log
- proof-product-hunt-audit/panels-after.log
- proof-product-hunt-audit/releases-worker-after.log
- .council-test/desktop-privacy-UU9zbb/settings.png
- /Users/crowelogic/crowe-logic-web/docs/product-hunt-proof/privacy-1280.png
- /Users/crowelogic/crowe-logic-web/docs/product-hunt-proof/privacy-390.png

The initial new-test failures were test-code defects, fixed and rerun successfully: a malformed selector expression and a same-document navigation returning no HTTP response object.

## Follow-up: checkout tests and memory review

- Ran the checkout repository's full offline suite: 26 verification checks and 59 Node tests passed, 85 total, zero failures. Evidence: /Users/crowelogic/crowe-checkout/reports/product-hunt-readiness-tests.log.
- Reran all four sign-in regression scenarios, the real desktop privacy test and the desktop plan checks successfully.
- Project memory explicitly distinguishes mock fixtures from sandbox payment evidence. The staging record says no isolated checkout staging environment existed when checked; its suggested preview uses production bindings and is not a safe payment sandbox.
- No Stripe test credential is configured in the current process. A real sandbox purchase, fresh Crowe ID provisioning and end-to-end entitlement refresh remain unverified. No live payment or customer account was changed.
- Messages memory identifies the supplied recipient as an established iMessage destination and requires delivery verification rather than trusting a successful send command. The current Messages tool request is awaiting approval; no report has been sent by this run.

## Follow-up 2026-09-20 02:5x MST (Claude Code session, on Michael's "proceed these tasks")

- Reran on the working tree: sign-in regression 4/4, real Electron desktop privacy test PASS, releases worker 51/51, electron-security 140, brand copy 29 files, plan checks, first run, preview drift clean.
- The local fixes are committed on branch `fix/desktop-privacy-signin` and pushed; the pull request against main is the release vehicle. Nothing merged, no version bump, no build.
- Developers 0.24.15: `release-developers/` holds seven artifacts built from clean 0.24.15 (the Mac app inside the arm64 zip has no privacy switch and no setUploadToServer call, so it is the same source as stable). codesign strict verify passes and spctl says Notarized Developer ID. `node scripts/preflight-release.js release-developers 0.24.15 --channel developers` reports 3 feeds, 7 artifacts verified. The upload itself (`scripts/publish-rclone.sh --config electron-builder.developer.js`) is a production publish and is left for Michael's word.
- Website privacy page: the working tree's "Where your messages go" section was checked against GET /api/gateway/catalog and corrected (see the crowe-logic-web commit); the crowe-logic-web deploy needs the console Terminal (wrangler keychain) and Michael's word.
- The Messages report to Michael is sent from this session, verified in chat.db.
