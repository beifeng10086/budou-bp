# Project update rules

- Before changing any version, run `npm run backup` and verify that the source ZIP, Git bundle and manifest exist. Back up the current working files before editing, including existing user changes. Do not treat a backup made after edits as the pre-update backup.
- Never overwrite or delete an older backup. Keep backups outside this repository in the sibling directory `武斗bp备份`.
- Deployment commands also run a backup hook. This is additional protection, not a replacement for the backup before edits.
- Preserve the free Cloudflare plan. A pricing question is not authorization to upgrade, buy a domain or incur charges.
- Display analytics as delayed estimates, never as an exact real-time balance. Never publish account credentials in frontend assets or Git.
