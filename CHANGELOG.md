# Changelog

Dates are release dates. 0.2.0 was tagged but never published, so upgrades go
0.1.0 → 0.3.0 → 0.4.0.

## 0.4.2 — 2026-08-19

### Changed

- `engines` drops from Node 23.6 to Node 22. The 23.6 requirement was type stripping,
  which only running from a clone needs; the published package is compiled JavaScript
  and the only modern syntax in it is optional chaining and `??=`. Node 22 is the
  active LTS, so the old floor turned away a large share of installs for a reason that
  did not apply to them. Running from source still needs 23.6.
- CI builds the package on Node 22 and runs `--doctor` with it on all three platforms,
  so the supported floor stays a measured fact rather than a one-off check.

## 0.4.1 — 2026-08-19

Documentation only. No change to the program.

### Added

- This file. Anyone on an older version had no way to find out what changed; the
  package shipped a README and nothing else. It is included in the published package,
  since npm ships a README and a LICENSE on its own but not a changelog.
- A Usage section directly under the screenshot in both READMEs: the commands, the
  keys, and a labelled status bar. Every field on that bar arrived after 0.1.0 and none
  of them were explained in one place — `awake:os` / `awake:self` / `awake:live` mean
  nothing without a legend.
- Install now covers updating with `npm i -g tui-saver@latest`, and the fact that an
  already-running instance keeps the version it started with.

## 0.4.0 — 2026-08-18

### Added

- `--while <pid>` ends the run when that process exits. The lock lasts exactly as long
  as the work it was taken for. A pid that is not running is refused rather than
  accepted silently.
- `--doctor` lists the locks other processes are holding, longest-held first, and says
  `LEAKED` when a `caffeinate -w` is waiting for a process that no longer exists.
- Inside tmux, the time spent with nothing on screen is counted and reported once
  somebody is there to read it. Detaching does not stop the run.
- The status bar names the host when the lock is held over ssh, so it is clear which
  machine is being kept awake.
- `--defeat-screensaver` is now verified rather than assumed: on every push, CI checks
  that the Windows pulse moves `GetLastInputInfo` and that the macOS pulse registers a
  `UserIsActive` assertion. On Linux the check fires the pulse and says it cannot
  confirm it landed.

### Fixed

- **Linux held no lock at all without a login session.** It asked logind for
  `idle:sleep`; polkit refuses the `sleep` half where there is no seat, and the request
  is atomic, so the `idle` half was refused with it. Over ssh, headless, or anywhere
  without a seat, the status bar said `awake` while nothing was held. It now asks for
  `idle`, which is granted either way.
- **A slow OS could be mistaken for a broken one.** The first re-verification ran half a
  second after launch, and a miss failed the run — so a lock the OS had not finished
  registering was reported as lost. The first answer now gets three seconds; after one
  has arrived there is no grace.
- The status bar corrupted itself. `⚡` is two columns wide and the canvas assumes one
  character per cell, which shifted everything after it. The charge now reads
  `bat 74% ac`.
- On a narrow terminal the awake indicator was the first thing dropped instead of the
  last. Its space is reserved before anything else is drawn.
- `--require-awake` gave up after five seconds, which was less than a loaded Windows
  machine needs to compile the shim its watcher uses. It now waits twenty, at no cost:
  a watcher that cannot hold the lock exits, and that is noticed at once.

### Changed

- The awake indicator names its evidence: `awake:os` when the OS confirms the lock,
  `awake:self` on the watcher's own word (Windows, where the OS cannot be asked without
  elevation), `awake:live` when a running watcher is all that is known.
- **Linux no longer blocks an explicit suspend.** A lid close, `systemctl suspend` or the
  power button will sleep the machine. Only the idle timer is held. Blocking more needed
  a session polkit would authorise, and asking for it was what broke the case above.

## 0.3.0 — 2026-08-18

### Added

- `--for 90m` and `--until 18:00` end the whole run. The status bar counts down and
  turns amber for the last minute; `+` adds fifteen minutes. With no limit it shows how
  long the run has been up instead.
- `--battery-floor <pct>`, on by default at 15. While discharging below that, the run
  warns for ten seconds, releases the lock and exits. `0` disables it. Machines with no
  battery are unaffected.
- `--require-awake` refuses to draw anything unless the lock is confirmed held.
- A lost lock draws a warning across the top row that no key hides, rings the terminal
  bell once, and makes the run exit 1 with the reason on stderr.
- The OS is asked again every 90 seconds. An answer that stops naming the lock fails the
  run even though the watcher is still alive.
- A watcher that dies is relaunched once, and reports why it died.
- CI runs the renderer checks and the real sleep-lock verification on macOS, Windows and
  Linux runners.

### Fixed

- **Windows discarded a failed lock request.** `SetThreadExecutionState` returns 0 when
  refused and the return value was thrown away, so a refused request left PowerShell
  waiting, holding nothing, while the status bar said `awake`.
- **Windows could not report why anything failed.** PowerShell serialises a redirected
  stderr as CLIXML, so the first line is always `#< CLIXML`. The watcher now reports on
  stdout.
- `--doctor` waited a fixed 3.5 seconds on Windows before asking the OS, guessing how
  long compiling the shim takes. It waits for the watcher to say it is ready.

### Changed

- The battery guard is on by default. A run may now end by itself where 0.1.0 never did.

## 0.1.0 — 2026-08-14

First release. 18 scenes in three render modes, and a sleep lock held by a watcher
process that releases it when this program goes away — including under `kill -9`.
