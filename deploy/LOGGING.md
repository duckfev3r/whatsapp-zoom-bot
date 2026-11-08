# Logs and rotation

The service logs JSON lines (pino) to stdout. systemd sends them to the journal.

## The journal (default)

journald rotates on its own. To cap its size, set this in `/etc/systemd/journald.conf`:

```
SystemMaxUse=200M
MaxRetentionSec=1month
```

Then run `sudo systemctl restart systemd-journald`.

Read the logs with:

```
journalctl -u whatsapp-zoom-bot -f
journalctl -u whatsapp-zoom-bot -o cat | npx pino-pretty
```

## Writing to a file instead

If you add `StandardOutput=append:/var/log/whatsapp-zoom-bot/bot.log` to the unit, rotate that file with logrotate. Save this as `/etc/logrotate.d/whatsapp-zoom-bot`:

```
/var/log/whatsapp-zoom-bot/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
```

`copytruncate` is needed because the process keeps the file open.

## What is never logged

Host keys, transcript text and secrets are not logged. The logs do contain group JIDs and meeting IDs.
