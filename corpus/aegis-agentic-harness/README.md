# Aegis Agentic Harness Corpus

Training and retrieval corpus derived from a user-provided GLM-5.2 response about a production-grade agentic harness for computer engineering and software development.

## Files

- `source.md`: cleaned, human-readable response
- `corpus.jsonl`: one complete instruction record and ten section-level knowledge records
- `manifest.json`: provenance, checksums, record counts, and applied transformations

## JSONL record types

- `instruction`: the complete prompt-response pair for supervised instruction use
- `knowledge`: one independently retrievable architectural section

Every record contains corpus identity, model provenance, source checksum, collection date, language, and domain labels.

## Rebuild

```sh
node scripts/build-aegis-corpus.mjs /path/to/pasted-text.txt
```
