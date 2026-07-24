# Third-party model notices

No model weights or upstream source snapshots are included in this repository.
The production worker accepts only explicitly provisioned, revision-marked local
snapshots.

- Kronos source, Kronos-base, and Kronos-Tokenizer-base: MIT License.
  Copyright remains with the upstream Kronos authors and contributors.
  Source: https://github.com/shiyu-coder/Kronos

The exact revisions used by the worker are recorded in `model-manifest.json` and
in every inference response. A deployment that provisions these artifacts must
also retain the complete corresponding upstream license and NOTICE files next
to the local model cache.
