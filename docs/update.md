# imp-aly - Updates

The server updates itself once a day to the newest compatible version. You do not need to do
anything. This page tells you what the update does, and how to control it.

## The update timer

`sudo imp-aly server` installs the systemd timer `imp-aly-update` with the service. Once a day, at a
random time, the timer runs `imp-aly update` as root. Look at the timer:

```sh
systemctl list-timers imp-aly-update
journalctl -u imp-aly-update -n 30
```

To turn off the updates, run the server command again with `--no-auto-update`:

```sh
sudo imp-aly server --port 2980 --no-auto-update
```

Run it again without `--no-auto-update` to turn the updates on again. `--uninstall` removes the
timer with the service.

## Update now

```sh
imp-aly update --check     # show the installed version and the update, install nothing
sudo imp-aly update        # install the update now
```

`imp-aly update` needs root when the binary is in `/usr/local/bin`. It does the same steps as the
timer. Without the systemd service, it replaces the binary only. Restart the server yourself.

## Which version the update installs

The update installs only a version that reads the same data folder:

| Installed | The update installs           | The update does not install |
| --------- | ----------------------------- | --------------------------- |
| `0.1.2`   | `0.1.3`, `0.1.4`, ...         | `0.2.0`, `1.0.0`            |
| `1.2.0`   | `1.2.1`, `1.3.0`, `1.9.4`,... | `2.0.0`                     |

Before `1.0.0`, a new minor version can change the data folder, the API and the commands. From
`1.0.0`, a new major version can change them. When such a version is out, `imp-aly update` tells
you. Read the release notes on https://github.com/sobanieca/imp-aly/releases, then install it with
the install script:

```sh
curl -fsSL https://sobanieca.github.io/imp-aly/install.sh | bash
sudo imp-aly server --port 2980
```

The data folder holds its format in `format.json`. The server does not start on a data folder of
another format. So a wrong version cannot change your data.

## What the update does

1. It reads the list of versions from https://sobanieca.github.io/imp-aly/versions.json and selects
   the newest compatible version.
2. It downloads the binary and its SHA-256 file from the GitHub Release of that version, to
   `.imp-aly.new` next to the binary. It checks the SHA-256, and it runs the new binary with
   `--version`. When a check fails, it removes the file and stops. Nothing changes.
3. It keeps the old binary as `.imp-aly.previous`, and it replaces the binary in one step. The
   running server does not see the change.
4. It restarts the service. The server ends the requests in progress, closes the write-ahead log,
   and stops. The new server starts and reads the log again. This takes 1 to 3 seconds.
5. It watches the service for 15 seconds. When the service does not stay running, the update puts
   the old binary back, restarts the service again and fails. It does not try that version again.

During the restart, the server does not answer. The imp sink sends the records of that time to the
next server in its `servers` list. With one server in the list, the records of those seconds are
lost. The timer selects a random time for each server, so two servers almost never restart at the
same time.

## Go back to the old version

The update keeps the previous binary. To use it again, stop the updates, then put it back:

```sh
sudo imp-aly server --port 2980 --no-auto-update
sudo mv /usr/local/bin/.imp-aly.previous /usr/local/bin/imp-aly
sudo systemctl restart imp-aly
```

## Try a skipped version again

A version that did not stay running is in `/var/lib/imp-aly-update/skipped.json`. Remove it from the
list, then run `sudo imp-aly update`.
