## Git

After every completed change, always commit and push to the remote repository, using the currently active Git branch.

## Test router

A router connected to the PC is available at 192.168.10.1.

The router has no password configured and is available for testing, verification and development of the project's features.

## Project language

The project is international: documentation (`docs/`, `CLAUDE.md`), the `tools/` scripts and their messages are written in English. New documentation pages are written in English.

## Two-language documentation

`README.md` (English, default version) and `README-it.md` (Italian) must always be changed together: every change to one of them must be carried over to the other in the same commit, keeping the same section structure.

The same applies to the interface texts: every new or changed text in `frontend/src/i18n/` must be written in both Italian and English.

The messages the backend (rpcd plugin, shell helpers, traveld) sends to the interface are in English and always carry a code (`fail_code code "message" key value`); the Italian and English translations of the code must be added to `frontend/src/i18n/backend.ts`.
