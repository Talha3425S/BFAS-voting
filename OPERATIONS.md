# Operations Toolkit

This Phase 2 toolkit adds repeatable database migrations plus backup and restore commands.

## Commands

Run from [backend](C:/Users/Dell/pioneer-blockchain-framework/backend):

```powershell
npm run migrate
npm run migrate:status
npm run backup:create
npm run backup:list
npm run backup:restore -- --backup=<backup-id>
```

Direct runner equivalents:

```powershell
node src/migrations/run.js up
node src/migrations/run.js status
node src/ops/backup.js create --label=my-backup
node src/ops/backup.js list
node src/ops/restore.js --backup=<backup-id>
```

## Migration Runner

- SQL migrations live in [sql](C:/Users/Dell/pioneer-blockchain-framework/backend/src/migrations/sql)
- Applied files are tracked in `schema_migrations`
- `npm run migrate:status` shows `APPLIED`, `PENDING`, or `CHANGED`

## Backup Format

Backups are written under [backups](C:/Users/Dell/pioneer-blockchain-framework/backend/backups).

Each backup folder contains:

- `manifest.json`
- `database.snapshot.json` when JSON snapshot mode is used
- `database.sql` when `pg_dump` is available
- `fabric/fabric-context.json`
- copied connection profiles when present

## Backup Notes

- The backup command prefers `pg_dump` automatically when available
- If `pg_dump` is not installed, it falls back to a JSON snapshot of public tables
- Fabric ledger volumes are not dumped here; this toolkit captures the backend DB plus Fabric connection references

## Restore Notes

- JSON snapshot restore truncates current public tables and reloads snapshot rows
- SQL restore uses `psql`, so PostgreSQL client tools must be installed for SQL-mode restores
- Run restore carefully against the intended database only

## Automation Scheduler

The backend now starts an operations scheduler automatically when [server.js](C:/Users/Dell/pioneer-blockchain-framework/backend/src/server.js) boots.

It handles:

- scheduled backup creation
- periodic health snapshots
- tamper and workflow drift alert persistence
- critical alert console logging

Useful environment variables:

```env
OPS_AUTOMATION_ENABLED=true
OPS_BACKUP_SCHEDULER_ENABLED=true
OPS_HEALTH_MONITOR_ENABLED=true
OPS_BACKUP_INTERVAL_MINUTES=1440
OPS_HEALTH_INTERVAL_MINUTES=30
OPS_BACKUP_STARTUP_DELAY_MS=60000
OPS_HEALTH_STARTUP_DELAY_MS=15000
OPS_ALERT_REPEAT_MINUTES=180
OPS_ALERT_MIN_SEVERITY=CRITICAL
```

## Alert Delivery

- Alert delivery now stays local to the backend console
- Critical alerts are persisted in `system_alerts` and logged by the scheduler without any SMTP or Gmail dependency
