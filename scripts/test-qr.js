#!/usr/bin/env node
// Proves qr.js produces codes a camera can actually read.
//
//   node scripts/test-qr.js
//
// Reading an encoder and believing it is how you ship a pairing screen that
// scans on nobody's phone. So this does not inspect the matrix and reason about
// it: it renders each symbol to a PNG and decodes it back with CIDetector —
// the same CoreImage QR detector iOS uses behind AVFoundation. If the round
// trip returns the string that went in, a phone can read it.
//
// The decode needs macOS (CoreImage) and rsvg-convert. Where either is missing
// — Linux CI — the structural checks still run and the decode says out loud
// that it was skipped, rather than passing quietly and implying more than it
// checked.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const qr = require("../qr");

let failures = 0;
let skipped = 0;
function check(name, fn) {
  try {
    const detail = fn();
    if (detail === "SKIP") { skipped += 1; console.log(`  skip ${name}`); return; }
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${String(e.message || e).split("\n").join("\n       ")}`);
  }
}
function assert(cond, message) { if (!cond) throw new Error(message); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "crowe-qr-"));
const have = (bin) => { try { execFileSync("which", [bin], { stdio: "ignore" }); return true; } catch { return false; } };
const CAN_DECODE = process.platform === "darwin" && have("swift") && have("rsvg-convert");

// CIDetector, via a throwaway Swift file. Compiling costs a second or two per
// run; a real decoder is worth it.
const DECODER = path.join(TMP, "decode.swift");
fs.writeFileSync(DECODER, `
import CoreImage
import Foundation
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let image = CIImage(contentsOf: url) else { FileHandle.standardError.write("unreadable image".data(using: .utf8)!); exit(2) }
let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: CIContext(),
                          options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])!
let found = detector.features(in: image).compactMap { ($0 as? CIQRCodeFeature)?.messageString }
print(found.joined(separator: "\\u{1}"))
`);

function decode(text, label) {
  const svg = path.join(TMP, `${label}.svg`);
  const png = path.join(TMP, `${label}.png`);
  fs.writeFileSync(svg, qr.toSvg(text, { scale: 8 }));
  execFileSync("rsvg-convert", [svg, "-o", png]);
  return execFileSync("swift", [DECODER, png], { encoding: "utf8" }).trim();
}

const CASES = [
  ["short", "https://crowelogic.com"],
  // The real thing: a pairing URL with a 64-hex token, which is what the
  // desktop will actually draw.
  ["pair", `com.crowelogic.mobile://pair?url=${encodeURIComponent("http://100.104.8.58:8787")}&token=${"a3f9".repeat(16)}`],
  ["long", `com.crowelogic.mobile://pair?url=${encodeURIComponent("http://100.127.255.254:8787")}&token=${"9c".repeat(32)}&name=${encodeURIComponent("Michael's MacBook Pro")}`],
];

console.log("qr");

for (const [label, text] of CASES) {
  check(`${label}: encodes to a square with a quiet zone`, () => {
    const { size, version, modules } = qr.encode(text);
    assert(size === 17 + version * 4, `size ${size} does not match version ${version}`);
    assert(modules.length === size && modules.every((r) => r.length === size), "matrix is not square");
    assert(modules.flat().every((v) => v === 0 || v === 1), "matrix holds something other than 0/1");
    return `${text.length} chars → version ${version}, ${size}×${size}`;
  });

  check(`${label}: has three finder patterns`, () => {
    const { size, modules } = qr.encode(text);
    // The centre 3x3 of a finder is dark, ringed by light at radius 1.
    for (const [r, c] of [[3, 3], [3, size - 4], [size - 4, 3]]) {
      assert(modules[r][c] === 1, `no dark centre at ${r},${c}`);
      assert(modules[r - 2][c] === 0 && modules[r][c - 2] === 0, `no light ring at ${r},${c}`);
    }
    return "top-left, top-right, bottom-left";
  });

  check(`${label}: a real QR decoder reads it back`, () => {
    if (!CAN_DECODE) return "SKIP";
    const got = decode(text, label);
    assert(got, "CIDetector found no QR code in the rendered image at all");
    assert(got === text, `decoded a different string\n       want: ${text}\n       got:  ${got}`);
    return `${got.length} chars round-tripped`;
  });
}

check("a payload too big for version 10 is refused, not silently truncated", () => {
  let threw = null;
  try { qr.encode("x".repeat(400)); } catch (e) { threw = e; }
  assert(threw, "400 bytes encoded without complaint");
  assert(/does not fit/.test(threw.message), `unhelpful message: ${threw.message}`);
  return threw.message;
});

fs.rmSync(TMP, { recursive: true, force: true });

if (skipped) {
  console.log(`\n${skipped} decode check(s) skipped: needs macOS with swift and rsvg-convert.`);
  console.log("The structural checks ran, but nothing here proved a scanner can read these.");
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall qr checks passed");
process.exit(failures ? 1 : 0);
