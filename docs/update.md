# imp-aly - Updates

The server updates itself once a day to a compatible release that is more than 7 days old. You do
not need to do anything. This page tells you what the update does, and how to control it.

## The update timer

`sudo imp-aly server` installs the systemd timer `imp-aly-update` with the service. Once a day, at a
random time, the timer runs `imp-aly update --auto` as root. Look at the timer:

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
imp-aly update --check     # show the installed version, the update and the choice of the timer
sudo imp-aly update        # install the newest version now, also a new major version
sudo imp-aly update --auto # install what the timer installs, now
```

`imp-aly update` needs root when the binary is in `/usr/local/bin`. Without the systemd service, it
replaces the binary only. Restart the server yourself.

## Which version the update installs

The timer installs a version only when all of these are true:

- It is newer than the installed version. An update never installs an older version.
- It reads the same data folder. The version list gives the data format of each version.
- It is in the same major version. Before `1.0.0`, it is in the same minor version.
- GitHub published its release more than 7 days ago.
- It did not fail on this server before.

| Installed | The timer installs            | The timer does not install |
| --------- | ----------------------------- | -------------------------- |
| `0.1.2`   | `0.1.3`, `0.1.4`, ...         | `0.2.0`, `1.0.0`           |
| `1.2.0`   | `1.2.1`, `1.3.0`, `1.9.4`,... | `2.0.0`                    |

Before `1.0.0`, a new minor version can change the data folder, the API and the commands. From
`1.0.0`, a new major version can change them. The timer never installs such a version. When one is
out, the update tells you in its log. Read the release notes on
https://github.com/sobanieca/imp-aly/releases, then install it yourself:

```sh
sudo imp-aly update
sudo imp-aly server --port 2980
```

`sudo imp-aly update` without `--auto` does not use the major version rule and the 7 days. It
installs the newest version that reads the same data folder. Run your `sudo imp-aly server` command
again after it, because a new major version can change the unit file.

The 7 days give time to find a bad release before it reaches the servers. The date comes from
GitHub, not from the release, so a release cannot show an older date.

The data folder holds its format in `format.json`. The server does not start on a data folder of
another format. So a wrong version cannot change your data.

## What the update does

1. It takes a lock, so two updates never run at the same time. A second update fails at once. When
   another update replaced the binary after this update started, this update stops.
2. It reads the list of versions from https://sobanieca.github.io/imp-aly/versions.json. The timer
   also reads the publish dates of the releases from the GitHub API. Then it selects the version.
3. It downloads the SHA-256 file from the GitHub Release of that version. Then it downloads the
   binary to `.imp-aly.new` next to the binary. It checks the SHA-256, and it runs the new binary
   with `--version`. When a check fails, it removes the file and stops. Nothing changes.
4. It keeps the old binary as `.imp-aly.previous`, and it replaces the binary in one step. The
   running server does not see the change.
5. It restarts the service. The server ends the requests in progress, closes the write-ahead log,
   and stops. The new server starts and reads the log again. This takes 1 to 3 seconds.
6. It watches the service for 15 seconds. When the service does not stay running, the update puts
   the old binary back, restarts the service again and fails. It does not try that version again.

During the restart, the server does not answer. The imp sink sends the records of that time to the
next server in its `servers` list. With one server in the list, the records of those seconds are
lost. The timer selects a random time for each server, so two servers almost never restart at the
same time.

## Trust

The update trusts GitHub Releases and HTTPS. The SHA-256 file comes from the same release as the
binary. So the SHA-256 finds a damaged download, but not a changed release. Somebody who can change
a release of imp-aly can give your servers a different binary. The 7 days give time to find and
delete such a release before the timer installs it.

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
