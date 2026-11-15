---
section: Fixed
issue: 1118
---

**The release changelog fold handles a BOM, lone-CR line endings and a failed run** (agbossjs/agboss#1118): a UTF-8 BOM before the version heading or CR-only line endings made `changelog-assemble` miss the section and write a second one (even for a released version); the file is now parsed as LF and written back in its own form, the written file is verified before it replaces CHANGELOG.md (a failed run leaves it byte-identical and keeps the fragments), a bullet with trailing spaces is not written twice, and the release checklist's static chain check also sees `a&&b` and `a &&\` and each block's first line.
