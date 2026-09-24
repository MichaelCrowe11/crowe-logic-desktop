#!/usr/bin/env python3
"""Read-only consistency checks, not product, media, rights or launch acceptance."""
import json
import re
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LANES = {
    "software": ("S", "UCIQxSp5Zp2Oaz9a22USFyfg", 40),
    "mycology": ("M", "UCTXP5BRecHpwa7_sFbbyMng", 39),
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def words(text):
    return re.findall(r"\b[\w]+(?:['’-][\w]+)*\b", text)


def validate():
    for shared in ("PRODUCTION.md", "QC-CHECKLIST.md"):
        require((ROOT / shared).is_file(), f"Missing {shared}")
    for lane, (prefix, channel, expected_count) in LANES.items():
        base = ROOT / lane
        for name in ("TREATMENT.md", "NARRATION-DRAFT.md", "EVIDENCE.md", "CAPTURE.md", "output-manifest.template.json"):
            require((base / name).is_file(), f"{lane}: missing {name}")
        narration = (base / "NARRATION-DRAFT.md").read_text()
        treatment = (base / "TREATMENT.md").read_text()
        evidence = (base / "EVIDENCE.md").read_text()
        manifest = json.loads((base / "output-manifest.template.json").read_text())
        paragraphs = re.findall(r"^### ([SM]\d+)\n(.*?)(?=\n### |\n## |\Z)", narration, re.M | re.S)
        ids = [key for key, _ in paragraphs]
        require(len(ids) == len(set(ids)) == expected_count, f"{lane}: paragraph identity/count mismatch")
        require(all(key.startswith(prefix) for key in ids), f"{lane}: wrong paragraph lane")
        count = sum(len(words(text)) for _, text in paragraphs)
        require(2400 <= count <= 2900, f"{lane}: review long-form pacing ({count} words)")
        require(count == manifest["draftWordCount"], f"{lane}: stale word count")
        require(expected_count == manifest["paragraphCount"], f"{lane}: stale paragraph count")
        require(manifest["expectedChannelId"] == channel, f"{lane}: wrong channel")
        require(channel in narration and channel in treatment, f"{lane}: channel not explicit in briefs")
        require(manifest["status"] == "BLOCKED_PREPRODUCTION_ONLY", f"{lane}: template must remain blocked")
        require(manifest["isPublicationPayload"] is False, f"{lane}: not an upload payload")
        require(manifest["voiceLock"]["approved"] is False, f"{lane}: no voice approval exists")
        require(all(value is None for value in manifest["release"].values()), f"{lane}: unaccepted release values")
        require(all(value is None for value in manifest["cta"].values()), f"{lane}: unverified CTA")
        require(all(value is None for value in manifest["deliverables"].values()), f"{lane}: no media deliverables exist")
        for field in ("acceptedSources", "approvedVoiceTakes", "acceptedMusicStems", "rightsClearances", "edl"):
            require(manifest[field] == [], f"{lane}: no accepted {field}")
        require(manifest["publication"]["attempted"] is False, f"{lane}: no upload attempted")
        require(all(value is None for key, value in manifest["publication"].items() if key != "attempted"), f"{lane}: no publication receipts")
        require(bool(manifest["blockers"]), f"{lane}: missing blockers")
        require("DRAFT NOT RECORDED" in narration, f"{lane}: missing draft label")
        require(bool(re.findall(r"\[[A-Z_]+\]", narration)), f"{lane}: release placeholders were removed without acceptance")
        bodies = "\n".join(text for _, text in paragraphs)
        require("—" not in bodies, f"{lane}: em dash in spoken copy")
        require(bodies.count("Crowe Logic. Know your next move.") == 1, f"{lane}: sign-off must occur once")
        if lane == "software":
            require(not re.search(r"\b(?:farm|grower|cultivation|mushroom|mycology)\b", bodies, re.I), "Software narration crosses audience boundary")
        else:
            require(not re.search(r"\b(?:repository|terminal|code editor|developer|pull request)\b", bodies, re.I), "Grower narration crosses audience boundary")
        cursor = 0
        covered = []
        for chapter in manifest["chapters"]:
            require(chapter["startSeconds"] == cursor and chapter["durationSeconds"] > 0, f"{lane}: chapter gap/overlap")
            require(chapter["id"] in treatment, f"{lane}: chapter missing from treatment")
            cursor += chapter["durationSeconds"]
            number = int(chapter["id"][1:])
            covered.extend(key for key in ids if int(key[1:]) // 100 == number)
        require(cursor == manifest["targetSeconds"] == 1200, f"{lane}: target duration mismatch")
        require(covered == ids, f"{lane}: unassigned narration paragraph")
        mapped = set()
        for match in re.finditer(r"\b([SM])(\d{3})-\1(\d{3})\b", evidence):
            letter, start, end = match.groups()
            mapped.update(f"{letter}{n}" for n in range(int(start), int(end) + 1))
        mapped.update(re.findall(r"\b[SM]\d{3}\b", evidence))
        require(set(ids) <= mapped, f"{lane}: paragraph missing from evidence map")
        # Approximately 19 minutes at this pace leaves about one minute for hinges.
        print(f"{lane}: {count} narration words, {len(ids)} paragraphs, {cursor}s editorial budget; {count / 140:.2f} min at 140 wpm (not measured audio)")

    farm = json.loads((ROOT / "mycology/example-farm.json").read_text())
    require(farm["importable"] is False, "Farm fixture must not imply importer compatibility")
    require(farm["status"] == "fictional-inputs-only-not-captured", "Farm fixture status")
    total = Decimal(farm["harvest"]["quantityLbs"])
    shipped = sum(Decimal(row["quantityLbs"]) for row in farm["shipments"])
    corrected = Decimal(farm["correction"]["quantityLbs"])
    expected = farm["expectedArithmetic"]
    require(shipped == Decimal(expected["shippedLbs"]), "Shipment total mismatch")
    require(total - shipped == Decimal(expected["remainingBeforeCorrectionLbs"]), "Original remaining mismatch")
    require(corrected - shipped == Decimal(expected["remainingAfterCorrectionLbs"]), "Corrected remaining mismatch")
    require(total == Decimal(expected["shipmentTimeHarvestLbs"]), "Snapshot quantity mismatch")
    require(Decimal(farm["negativeAllocation"]["quantityLbs"]) > total - shipped, "Negative allocation must exceed remaining")
    require(all(row["requestId"] is None for row in farm["shipments"]), "Do not forge product-generated request IDs")
    require(farm["harvest"]["sourceId"] is None and farm["harvest"]["generatedLotCode"] is None, "Do not forge source/lot identities")
    for name in ("REQUIREMENTS.md", "summary.cjs", "summary.test.cjs"):
        require((ROOT / "software/sample-project" / name).is_file(), f"Missing sample file {name}")
    print("PASS: offline preproduction consistency only. Product, captures, rights, audio, media QC and publication remain unaccepted.")


if __name__ == "__main__":
    try:
        validate()
    except (ValueError, KeyError, OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"Preproduction validation failed: {error}")
