# Bounded icon history supplement

The nine final application artwork files are distinct from the sidebar Dragon emoji.

- 2026-06-29, ea2ca6cbac14b768caeb5eb0e4dcf650730698a4: replaces the original upstream icon with a self-contained geometric E/lightning SVG. This intermediate SVG is later deleted.
- 2026-06-29, cc64c026d62953f974d7eed23270791e0776e325: introduces a 1024x1024 source PNG and records applying generated artwork. The original source PNG's 29,026-byte caBX/C2PA payload contains OpenAI Media Service API, gpt-image, trainedAlgorithmicMedia and creation/action markers. These are metadata observations; the C2PA signature was not verified.
- 2026-07-05, f26813b3532d1c157c2d813f0d8d85466c49896b: records enlargement and replaces all nine images/icon variants. All nine 0.2.31 blobs are byte-identical to this commit. Its source PNG no longer contains the earlier caBX metadata.

Seven variant/icon paths were first tracked in the recovery baseline; the source PNG and frontend PNG were first introduced in cc64c026. First introduction and latest content commits for every file are in JSON.

The separate sidebar element is Unicode U+1F409 in MainLayout/index.tsx:87, rendered by Segoe UI Emoji / Apple Color Emoji / Noto Color Emoji in globals.css:3360. It is not proof that the nine application icon binaries were generated from a system emoji glyph.

The evidence supports describing the source method as generated artwork recorded in the project history, with earlier embedded OpenAI gpt-image metadata and subsequent project enlargement. It does not establish prompts, reference-art provenance, generator contracts, exclusive legal copyright, or complete rights clearance. Do not use an AGPL project declaration to assert ownership of third-party artwork, trademarks, or host fonts.

No reproducible icon-generation script or rights grant appears in the three inspected tracked changes. The full asset origin and rights remain partially unresolved; retain that boundary in NOTICE.
