# CLAUDE.md

Read `CONTEXT.md` before changing domain behavior or vocabulary.

Every sound clip added to `public/sounds/` goes through
`scripts/normalize-sound.py` before it ships:

```sh
brew install lame   # once; lame both decodes and encodes (sudo apt install lame on the Pi)
python3 scripts/normalize-sound.py ~/Downloads/foo.mp3 public/sounds/foo.mp3
```

Clips uploaded through the Admin Console go through the same script automatically
on the Pi, into `public/sounds/uploads/` (gitignored, Pi-only).

It does two things every clip needs, in one pass from the original download so
the result is only one mp3 generation from source: tops the leading silence up to
250ms so a slow audio sink cannot clip the opening, and applies the gain that
puts it at the same loudness as every other clip. Both are measured and topped
up rather than applied blindly — most downloads arrive with some lead-in already,
and their levels vary by more than 15 dB. Do not hand-roll either step; the
script prints before/after numbers, so paste those as your evidence.

The only outstanding acceptance work is the Raspberry Pi deployment check in
`.scratch/pr-arcade/issues/07-pi-deployment-setup-walkthrough.md`.
